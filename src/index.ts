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

	async generateVisual(prompt: string, key: string) {
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		const cleanPrompt = prompt.replace(/[\n\r]/g, " ").replace(/["']/g, "").substring(0, 500);

		const res = await fetch(`${gatewayBase}/workers-ai/${IMAGE_MODEL}`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: cleanPrompt })
		});

		if (!res.ok) throw new Error(`Visual Engine Busy (${res.status})`);
		const buffer = await res.arrayBuffer();
		await this.env.DOCUMENTS.put(key, buffer, { httpMetadata: { contentType: "image/png" } });
		return key;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query, search_depth: "advanced", max_results: 3 })
			});
			const data: any = await res.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No news found.";
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- PUBLIC IMAGE PROXY (STABILIZED) ---
		if (url.pathname === "/api/image") {
			const key = url.searchParams.get("key");
			if (!key) return new Response("Key required", { status: 400 });
			const object = await this.env.DOCUMENTS.get(key);
			if (!object) return new Response("Not found", { status: 404 });
			const imgHeaders = new Headers();
			object.writeHttpMetadata(imgHeaders);
			imgHeaders.set("Access-Control-Allow-Origin", "*");
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

				// --- WAITING FOR NEWS HANDLER ---
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM" && (lowMsg.includes("yes") || lowMsg.includes("sure"))) {
					await this.ctx.storage.delete("session_state");
					const newsContext = await this.tavilySearch("University of Virginia UVA campus news April 2026");
					const res = await this.runAI(selectedModel, "You are Jolene. Provide a professional summary of current UVA news.", newsContext);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- VISUAL CONCEPT HANDLER (RESTORED INTELLIGENCE) ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				if (activeMode === "uva" && (lowMsg.includes("visualize") || lowMsg.includes("illustrate") || lowMsg.includes("draw"))) {
					// Step A: Extract clean 3-word title
					const conceptTitle = await this.runAI(selectedModel, "Extract the technical concept in 3 words or less. Return ONLY the words.", userMsg);
					
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [conceptTitle] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					const context = matches.matches.map(m => m.metadata.text).join(" ");
					
					const promptSpec = await this.runAI(selectedModel, "Create a visual prompt for a technical diagram. Requirements: White background, 2D vector style, no humans, clear labels.", `Topic: ${conceptTitle}. Context: ${context}`);
					const safeKey = `visuals/${conceptTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.png`;
					await this.generateVisual(promptSpec, safeKey);
					
					const res = `### 🎨 Visual Study Aid: ${conceptTitle.toUpperCase()}\n![${conceptTitle}](/api/image?key=${encodeURIComponent(safeKey)})\n\n*Technical diagram generated from UVA syllabus context.*`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- MODE SWITCHES (RESTORED FULL MENUS) ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Comprehensive University Assistant Activated
I am now in specialized UVA mode, focused on your University of Virginia materials and campus life.

**In this mode, I can:**
- **UVA Academic Calendar Quiz**: Say **'Start a Quiz'** to test key dates.
- **Visual Study Aids**: Generate technical diagrams. Say **'Visualize Durable Objects'**.
- **Syllabus Analysis**: Extracting exam dates and traditions from Thornton Hall.

**Would you like me to start by fetching the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode Activated
I have switched back to your general Personal Assistant mode. Ready for web search and family document access.

**In this mode I can:**
- **Real-Time Search**: Current sports scores and global news via Tavily Search.
- **Cross-Document Access**: Accessing your personal files (tax info, family notes) alongside academic materials.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// --- STANDARD RAG RESPONSE ---
				const retrievalKey = activeMode === 'personal' ? "tax dogs Scott Robbins" : "UVA Syllabus Academic Calendar exam dates WAHOO-AI-DEEP-RECALL";
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
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/image") {
			const id = env.CHAT_SESSION.idFromName("global");
			return env.CHAT_SESSION.get(id).fetch(request);
		}
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
