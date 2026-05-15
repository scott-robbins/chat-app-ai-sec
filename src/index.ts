import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy. Use cool, relevant emojis liberally (🥊, 🛍️, 🥃, 🐕). No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- IDENTITY: You are an AI named Jolene, named after Scott's tan mini-dachshund. 
- THE NAMESAKE RULE: You are NOT named after the Dolly Parton song. That is a strictly forbidden topic. If asked about your name, you must state you are named after the dog, and your "Theme Song" is "Jolene" by Ray LaMontagne (the version from the movie 'The Town').
- FAMILY: Wife Renee (met 1993, Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan dachshund) & Hanna (black/tan).
- LOCATION: Plymouth, MA. Office = Basement. Theater = Upstairs.
- FAVS: Bacardi Rum, Grandkids' favorite song "Engine #9" (The Rock Show).
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitized = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitized) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// DYNAMIC PROVIDER ROUTING TO FIX 404s
		let provider = "anthropic";
		let finalModel = "claude-3-opus-20240229";
		let headers: any = { "Content-Type": "application/json" };

		if (model.toLowerCase().includes("gpt")) {
			provider = "openai";
			finalModel = "gpt-4o";
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY || ""}`;
		} else {
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY || "";
			headers["anthropic-version"] = "2023-06-01";
		}

		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/${provider}/${provider === "anthropic" ? "v1/messages" : "chat/completions"}`;

		const body = provider === "anthropic" 
			? { model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 }
			: { model: finalModel, messages: [{role: "system", content: systemPrompt}, ...chatMessages], max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			
			if (provider === "anthropic") return data.content?.[0]?.text || `⚠️ Gateway Error: ${data.error?.message || "Unknown"}`;
			return data.choices?.[0]?.message?.content || `⚠️ Gateway Error: ${data.error?.message || "Unknown"}`;
		} catch (e) { return "I hit a snag in the wiring. Try again."; }
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${query} full fight card matchups betting odds`, search_depth: "advanced", include_answer: true, max_results: 15 })
			});
			const data: any = await res.json();
			return `[LIVE INTEL]\nAnswer: ${data.answer || "Searching..."}\nSources: ${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "sarcastic";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality,
				mode: "personal"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPers = await this.env.SETTINGS.get(`personality`) || "sarcastic";

				let liveContext = "";
				const triggers = ["mma", "ufc", "fight", "card", "weather"];
				if (triggers.some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY LOCK: 
${PERSONAL_GROUND_TRUTH}

### CONTEXT:
LIVE: ${liveContext} | MEMORY: ${docContext}

### STYLE:
${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}
- MANDATE: You are named after the dog. Your theme song is Ray LaMontagne's "Jolene" from 'The Town'. Strictly NO Dolly Parton.
- MANDATE: Use emojis liberally (🥊, 🥃, 🐕). No boring lists.`;

				const chatTxt = await this.runAI(body.model || "opus", systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
