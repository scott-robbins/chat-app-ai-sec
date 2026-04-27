import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Persistence Error:", e); }
	}

	// --- HELPER: UNIVERSAL AI BROKER (ALL ROUTED THROUGH AI GATEWAY) ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg);
			}
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		let url = "";
		let headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: any = {};

		if (model.startsWith("@cf/")) {
			url = `${gatewayBase}/workers-ai/${model}`;
			headers["Authorization"] = `Bearer ${this.env.CF_API_TOKEN}`;
			body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else if (model.includes("gpt")) {
			url = `${gatewayBase}/openai/chat/completions`;
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], max_tokens: 800 };
		} else if (model.includes("claude")) {
			url = `${gatewayBase}/anthropic/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
			body = { model, max_tokens: 800, system: systemPrompt, messages: chatMessages };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (data.error) throw new Error(`Gateway Error (${model}): ${data.error.message || JSON.stringify(data.error)}`);

		if (model.startsWith("@cf/")) return data.result.response;
		if (model.includes("gpt")) return data.choices[0].message.content;
		if (model.includes("claude")) return data.content[0].text;
		return "Error: Unsupported model.";
	}

	// --- HELPER: ROBUST IMAGE GENERATION ---
	async generateVisual(prompt: string, filename: string) {
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;

		const res = await fetch(`${gatewayBase}/workers-ai/${IMAGE_MODEL}`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt })
		});

		if (!res.ok) throw new Error("Visual Engine Error.");

		const contentType = res.headers.get("content-type") || "";
		let base64Data = "";

		if (contentType.includes("application/json")) {
			const json: any = await res.json();
			base64Data = json.result?.image || json.image || "";
			const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
			await this.env.DOCUMENTS.put(`visuals/${filename}.png`, binary, { httpMetadata: { contentType: "image/png" } });
		} else {
			const buffer = await res.arrayBuffer();
			await this.env.DOCUMENTS.put(`visuals/${filename}.png`, buffer, { httpMetadata: { contentType: "image/png" } });
			const bytes = new Uint8Array(buffer);
			let binary = "";
			for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
			base64Data = btoa(binary);
		}
		return `data:image/png;base64,${base64Data}`;
	}

	async tavilySearch(query: string) {
		try {
			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY || "",
					query: `${query} current status April 2026`,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) { return "Web search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- ENDPOINT: DELETE ASSET FROM R2 ---
		if (url.pathname === "/api/delete" && request.method === "DELETE") {
			try {
				const { filename } = await request.json() as { filename: string };
				await this.env.DOCUMENTS.delete(filename);
				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/upload" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const text = await file.text();
				const filename = file.name;
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				await this.env.DOCUMENTS.put(filename, text);
				const segments = text.match(/[\s\S]{1,1000}/g) || [text];
				const vectors = [];
				for (let i = 0; i < segments.length; i++) {
					const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: [segments[i]] });
					vectors.push({ id: `${filename}-${i}`, values: embedding.data[0], metadata: { text: segments[i], filename, segment: activeMode } });
				}
				await this.env.VECTORIZE.upsert(vectors);
				return new Response(JSON.stringify({ success: true }), { headers });
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");
				return new Response(JSON.stringify({
					profile: "Scott E Robbins | Senior Solutions Engineer",
					messages: history.results || [],
					messageCount: history.results?.length || 0,
					knowledgeAssets: storage.objects.map(o => o.key),
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active" }
				}), { headers });
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				// --- 1. STATE-BASED HANDLERS (RESTORATION) ---
				if (lowMsg.includes("stop quiz")) {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					const stopRes = "### 🛑 Session Reset\nI have stopped the current activity. How else can I help?";
					await this.saveMsg(sessionId, 'assistant', stopRes);
					return new Response(`data: ${JSON.stringify({ response: stopRes })}\n\ndata: [DONE]\n\n`);
				}

				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure")) {
						const newsContext = await this.tavilySearch("University of Virginia UVA campus news and events");
						const newsTxt = await this.runAI(selectedModel, "You are Jolene. Provide a professional summary of current UVA news.", `NEWS:\n${newsContext}`);
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					}
				}

				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-d][\.\s]?$/i.test(lowMsg)) {
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					let score = await this.ctx.storage.get("quiz_score") as number || 0;
					const currentQ = pool[qIdx];
					const userChoice = lowMsg[0].toUpperCase();
					const isCorrect = userChoice === currentQ.hidden_answer.toUpperCase();
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }

					let gradeTxt = await this.runAI(selectedModel, "Explain the answer briefly based on UVA context.", `USER: ${userChoice}\nCORRECT: ${currentQ.hidden_answer}`);
					const feedback = isCorrect ? `✅ **Correct!**\n\n${gradeTxt}` : `❌ **Incorrect.**\n\n${gradeTxt}`;

					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const nextQ = pool[qIdx + 1];
						const nextUi = `\n\n---\n\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n\n${nextQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}`;
						await this.saveMsg(sessionId, 'assistant', feedback + nextUi);
						return new Response(`data: ${JSON.stringify({ response: feedback + nextUi })}\n\ndata: [DONE]\n\n`);
					} else {
						const final = `\n\n---\n\n### 🏁 Quiz Complete!\n**Score: ${score}/5**\n\nActivity state reset.`;
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.saveMsg(sessionId, 'assistant', feedback + final);
						return new Response(`data: ${JSON.stringify({ response: feedback + final })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- 2. VISUAL CONCEPT HANDLER ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				if (activeMode === "uva" && (lowMsg.includes("visualize") || lowMsg.includes("illustrate"))) {
					const concept = lowMsg.replace(/visualize|illustrate|of|the/g, "").trim();
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [concept] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					const context = matches.matches.map(m => m.metadata.text).join(" ");
					const promptSpec = await this.runAI(selectedModel, "Create a professional technical diagram prompt.", `Draw: "${concept}". Context: ${context}. Requirements: White background, academic style, clear labels.`);
					const imageDataUrl = await this.generateVisual(promptSpec, concept.replace(/\s+/g, '_'));
					const resText = `### 🎨 Visual Aid: ${concept.toUpperCase()}\n![${concept}](${imageDataUrl})\n\n*Archived in R2.*`;
					await this.saveMsg(sessionId, 'assistant', resText);
					return new Response(`data: ${JSON.stringify({ response: resText })}\n\ndata: [DONE]\n\n`);
				}

				// --- 3. MODE SWITCHES ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Comprehensive University Assistant Activated\nI am now focused on your UVA materials. Would you like campus news first?`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated\nReady for personal tasks and web search.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				// --- 4. STANDARD RAG & IDENTITY LOCK ---
				const historyRows = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 4").bind(sessionId).all();
				const chatHistory = (historyRows.results || []).reverse();
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
				const docContext = vectorResults.matches.map(m => m.metadata.text).join("\n\n");
				const systemPrompt = `Identity: Jolene, Scott Robbins' assistant. Namesake: tan dachshund dog. Mode: ${activeMode}. DOCS: ${docContext.substring(0, 3000)}.`;
				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, chatHistory);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "**Error:** " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string): Promise<Response> {
		try {
			const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar 2026 Registration"] });
			const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
			const context = matches.matches.map(m => m.metadata.text).join("\n");
			const prompt = `Generate 5 MCQs as JSON array from context: ${context}. Format: [{"q":"...","options":["..."],"hidden_answer":"A"}]`;
			const raw = await this.runAI(model, "JSON generator.", prompt);
			const pool = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("quiz_score", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
			const firstQ = pool[0];
			const uiRes = `### 🎓 UVA Quiz Started!\n\n---\n\n### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.map((o:string, i:number) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}`;
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Quiz Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
