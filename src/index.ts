import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	// --- HELPER: UNIVERSAL AI BROKER ---
	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) {
					chatMessages.push(msg);
				}
			}
		}

		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

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
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else if (model.includes("claude")) {
			url = `${gatewayBase}/anthropic/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
			body = { model, max_tokens: 1024, system: systemPrompt, messages: chatMessages };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (data.error) throw new Error(`Gateway Error (${model}): ${data.error.message || JSON.stringify(data.error)}`);

		if (model.startsWith("@cf/")) return data.result.response;
		if (model.includes("gpt")) return data.choices[0].message.content;
		if (model.includes("claude")) return data.content[0].text;
		throw new Error(`Model ${model} response format not handled.`);
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

		// --- ENDPOINT: UPLOAD & MEMORIZE ---
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
					vectors.push({
						id: `${filename}-${i}`,
						values: embedding.data[0],
						metadata: { text: segments[i], filename, segment: activeMode }
					});
				}
				await this.env.VECTORIZE.upsert(vectors);
				return new Response(JSON.stringify({ success: true, message: `Memorized: ${filename}` }), { headers });
			} catch (e: any) {
				return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
			}
		}

		// --- ENDPOINT: PROFILE SYNC ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
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
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- ENDPOINT: CHAT ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				// 1. News Confirmation Logic
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("ok")) {
						const newsContext = await this.tavilySearch("University of Virginia UVA campus news and events");
						const newsTxt = await this.runAI(selectedModel, "You are Jolene. Provide a professional summary of current UVA campus news.", `WEB NEWS:\n${newsContext}`);
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					}
				}

				// 2. Hardened Mode Switching
				if (lowMsg.includes("switch to uva mode") || (lowMsg.includes("uva mode") && (lowMsg.includes("switch") || lowMsg.includes("go to")))) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Comprehensive University Assistant Activated
I am now in specialized UVA mode, focused on your University of Virginia materials and campus life.

**Capabilities in this mode:**
1. **UVA Academic Calendar Quiz**: Test your knowledge on important dates. Say **'Start a Quiz'**.
2. **Syllabus Analysis**: Extracting exam dates and traditions from Thornton Hall.
3. **Campus News**: Say **'Fetch UVA News'** for the latest from the Lawn.
4. **Academic Q&A**: High-precision answers based on your documents.

**Would you like me to start by fetching the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode") || (lowMsg.includes("personal mode") && (lowMsg.includes("switch") || lowMsg.includes("go to")))) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched back to your general Personal Assistant mode. Ready for web search and family document access.

**In this mode I can:**
- **Real-Time Search**: Current sports scores and global news via **Tavily Search**.
- **Cross-Document Access**: Accessing your tax files and personal notes alongside academic materials.
- **Identity Context**: I have a full understanding of Scott, Renee, Bryana, and the dogs.`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				// 3. Hardened RAG Retrieval & Identity Lock
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				let webContext = "";
				if (activeMode === 'personal' && (lowMsg.includes("news") || lowMsg.includes("status") || lowMsg.includes("score"))) {
					webContext = await this.tavilySearch(userMsg);
				}

				const today = "Tuesday, April 28, 2026";
				const systemPrompt = `### IDENTITY LOCK: MANDATORY FACTS
You are Jolene, Scott Robbins' personal AI assistant. 
1. SCOTT'S JOB: Senior Solutions Engineer at Cloudflare.
2. FAMILY: Wife is Renee. Daughter is Bryana (Bry). Grandkids are Callan and Josie.
3. DOGS: Scott and Renee have TWO dogs: Jolene (tan mini-dachshund) and Hanna (black/tan mini-dachshund).
4. FACT CHECK: There is NO dog named Ruby. If "Ruby" is mentioned, clarify that you don't know who that is and Jolene is the oldest dog.
5. NEGATIVE CONSTRAINT: DO NOT mention Dolly Parton.
6. PRIMARY DIRECTIVE: Use the provided DOCS as the absolute source of truth.

Mode: ${activeMode.toUpperCase()}. Date: ${today}.
WEB: ${webContext}
DOCS: ${docContext}`;

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
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
