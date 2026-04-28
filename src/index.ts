import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	// --- HELPER: AI BROKER (TPM HARDENED) ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else { chatMessages.push({ role: "user", content: userQuery }); }

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: any = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], max_tokens: 800 };
		let url = "";

		if (model.startsWith("@cf/")) {
			url = `${gatewayBase}/workers-ai/${model}`;
			headers["Authorization"] = `Bearer ${this.env.CF_API_TOKEN}`;
			body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else if (model.includes("gpt")) {
			url = `${gatewayBase}/openai/chat/completions`;
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
		} else if (model.includes("claude")) {
			url = `${gatewayBase}/anthropic/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
			body = { model, max_tokens: 800, system: systemPrompt, messages: chatMessages };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (data.error) throw new Error(`Gateway Error: ${data.error.message || JSON.stringify(data.error)}`);

		if (model.startsWith("@cf/")) return data.result.response;
		if (model.includes("gpt")) return data.choices[0].message.content;
		if (model.includes("claude")) return data.content[0].text;
		return "Model logic error.";
	}

	// --- HELPER: R2 IMAGE STORAGE ---
	async generateVisual(prompt: string, key: string) {
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		const cleanPrompt = prompt.replace(/[\n\r]/g, " ").replace(/["']/g, "").substring(0, 500);

		const res = await fetch(`${gatewayBase}/workers-ai/${IMAGE_MODEL}`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: cleanPrompt })
		});

		if (!res.ok) throw new Error(`Visual Engine Busy. Please try again.`);

		const buffer = await res.arrayBuffer();
		await this.env.DOCUMENTS.put(key, buffer, { httpMetadata: { contentType: "image/png" } });
		return key;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- ENDPOINT: IMAGE PROXY (STABILIZED) ---
		if (url.pathname === "/api/image") {
			const key = url.searchParams.get("key");
			if (!key) return new Response("Key required", { status: 400 });
			const object = await this.env.DOCUMENTS.get(key);
			if (!object) return new Response("Not found", { status: 404 });
			const imgHeaders = new Headers();
			object.writeHttpMetadata(imgHeaders);
			imgHeaders.set("Access-Control-Allow-Origin", "*");
			imgHeaders.set("Cache-Control", "public, max-age=3600");
			return new Response(object.body, { headers: imgHeaders });
		}

		if (url.pathname === "/api/delete" && request.method === "DELETE") {
			const { filename } = await request.json() as { filename: string };
			await this.env.DOCUMENTS.delete(filename);
			return new Response(JSON.stringify({ success: true }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: "Scott E Robbins | Senior Solutions Engineer",
				messages: history.results || [],
				messageCount: stats?.total || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				activeQuiz: !!activePool,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				// --- 1. QUIZ HANDLER (SYLLABUS LOCKED) ---
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-d]/.test(lowMsg)) {
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					let score = await this.ctx.storage.get("quiz_score") as number || 0;
					const currentQ = pool[qIdx];
					const isCorrect = lowMsg[0].toUpperCase() === currentQ.hidden_answer.toUpperCase();
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					
					let feedback = isCorrect ? `✅ **Correct!**` : `❌ **Incorrect.** The answer was ${currentQ.hidden_answer}.`;
					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const nextQ = pool[qIdx + 1];
						const nextUi = `\n\n---\n### 📝 Question ${qIdx + 2} of 5\n**${nextQ.q}**\n${nextQ.options.map((o:any, i:any) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}`;
						await this.saveMsg(sessionId, 'assistant', feedback + nextUi);
						return new Response(`data: ${JSON.stringify({ response: feedback + nextUi })}\n\ndata: [DONE]\n\n`);
					} else {
						const final = `\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**\n\nSession reset. What's next?`;
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.saveMsg(sessionId, 'assistant', feedback + final);
						return new Response(`data: ${JSON.stringify({ response: feedback + final })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- 2. VISUAL CONCEPT HANDLER (STABILIZED) ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				if (activeMode === "uva" && (lowMsg.includes("visualize") || lowMsg.includes("illustrate") || lowMsg.includes("draw"))) {
					// STEP A: Use LLM to extract a clean CONCEPT TITLE (fixes the all-caps repetition)
					const conceptTitle = await this.runAI(selectedModel, "Extract the core technical concept from this prompt in 3 words or less. Return ONLY the words.", userMsg);
					
					// STEP B: Search Syllabus
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [conceptTitle] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					const context = matches.matches.map(m => m.metadata.text).join(" ");
					
					// STEP C: Expand Prompt for Image Model
					const promptSpec = await this.runAI(selectedModel, "You are a prompt engineer for technical diagrams.", `Draw a 2D vector schematic for: "${conceptTitle}". Based on: ${context}. Requirements: White background, professional engineering style, clear nodes, NO humans, legible labels.`);
					
					// STEP D: Save to R2 with encoded filename
					const safeFilename = conceptTitle.toLowerCase().replace(/[^a-z0-9]/g, '_');
					const r2Key = `visuals/${safeFilename}_${Date.now()}.png`;
					await this.generateVisual(promptSpec, r2Key);
					
					const res = `### 🎨 Visual Study Aid: ${conceptTitle.toUpperCase()}\n![${conceptTitle}](/api/image?key=${encodeURIComponent(r2Key)})\n\n*Technical diagram generated from your UVA syllabus and archived in R2.*`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- 3. MODE SWITCHES ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const res = `### 🎓 UVA Mode: Comprehensive University Assistant Activated
I am now in specialized UVA mode, focused on your academic materials.

**In this mode, I can:**
- **UVA Academic Calendar Quiz**: Say **'Start a Quiz'**.
- **Visual Study Aids**: Generate technical diagrams. Say **'Visualize Durable Objects'**.
- **Syllabus Analysis**: Extracting exam dates and traditions from Thornton Hall.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated
I have switched back to your general Personal Assistant mode. Ready for web search and family document access.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, selectedModel);

				// --- 4. STANDARD RAG RESPONSE ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar Thornton Rice Hall WAHOO-AI-DEEP-RECALL";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `Identity: Jolene, Scott Robbins' assistant. Named after dachshund Jolene. Mode: ${activeMode}. DOCS: ${docContext.substring(0, 3000)}.`;
				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "**System Error:** " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string): Promise<Response> {
		try {
			const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar Registration Exam Dates Thornton Rice Hall May 2026"] });
			const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
			const context = matches.matches.map(m => m.metadata.text).join("\n");
			const prompt = `CONTEXT:\n${context}\n\nTASK: Generate 5 MCQs specifically about the UVA Academic Calendar. Return ONLY JSON array. Format: [{"q":"...","options":["..."],"hidden_answer":"A"}]`;
			const raw = await this.runAI(model, "JSON quiz generator.", prompt);
			const pool = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("quiz_score", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
			const firstQ = pool[0];
			const res = `### 🎓 UVA Quiz Started!\n---\n### 📝 Q1 of 5\n**${firstQ.q}**\n${firstQ.options.map((o:any, i:any) => `${['A','B','C','D'][i]}. ${o}`).join('\n')}`;
			await this.saveMsg(sessionId, 'assistant', res);
			return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Quiz Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
