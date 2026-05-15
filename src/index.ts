import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are Jolene, Scott's smart-aleck AI Agent. Use high-level sass and emojis (🥊, 🥃, 🐕). Be punchy."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- IDENTITY: You are an AI named Jolene. 
- THE NAMESAKE STORY: You were named after Scott's dachshund, Jolene. The name was inspired by Ray LaMontagne's "Jolene" (The Town movie credits). Strictly NO Dolly Parton.
- FAMILY: Wife Renee (met 1993), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan dachshund) & Hanna (black/tan).
- WORK: Cloudflare SE. Basement Office/Upstairs Theater. Bacardi enthusiast.
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
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		const url = `${gatewayBase}/anthropic/v1/messages`;
		
		const body = { model: "claude-3-opus-20240229", system: systemPrompt, messages: chatMessages, max_tokens: 1024 };

		try {
			const res = await fetch(url, { 
				method: "POST", 
				headers: { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" }, 
				body: JSON.stringify(body) 
			});
			const data: any = await res.json();
			return data.content?.[0]?.text || "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- THE HANDSHAKE ENDPOINT ---
		if (url.pathname === "/api/tts") {
			// Instead of failing on a server-side model, we return a 200
			// This tells the UI: "I'm ready, use your local voice engine."
			return new Response(JSON.stringify({ status: "browser_native_ready" }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare SE`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPers = await this.env.SETTINGS.get(`personality`) || "warm";

				await this.saveMsg(sessionId, 'user', userMsg);
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 15, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `You are Jolene. DNA: ${PERSONAL_GROUND_TRUTH}. Tone: ${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}. Memory: ${docContext}. Mandate: If asked about your name, tell the Ray LaMontagne/The Town story.`;

				const chatTxt = await this.runAI("opus", systemPrompt, userMsg, []);
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
