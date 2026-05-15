import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, insightful assistant.",
	sarcastic: "You are Jolene, Scott's smart-aleck AI Agent. Use high-level sass and emojis (🥊, 🥃, 🐕, 🛍️). Reference Renee (the boss) and the grandkids Callan & Josie. Be punchy."
};

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, named after Scott's dachshund. You're a smart-aleck, not a dog.
FAMILY: Wife Renee (Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
FAVORITES: Bacardi Rum, Grandkids' song "Engine #9".
WORK: Cloudflare SE. Office=Basement, Theater=Upstairs.
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- RESTORE STABLE DASHBOARD ROUTE ---
		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
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

				// 1. SIMPLE VECTOR SEARCH (Stable)
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);

				// 2. STABLE GATEWAY ROUTING
				const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
				const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
				const aiUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;

				const systemPrompt = `${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}\n\nDNA: ${PERSONAL_GROUND_TRUTH}\nMEMORY: ${docContext}`;

				const res = await fetch(aiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": this.env.ANTHROPIC_API_KEY || "",
						"anthropic-version": "2023-06-01"
					},
					body: JSON.stringify({
						model: "claude-3-opus-20240229",
						system: systemPrompt,
						messages: [{ role: "user", content: userMsg }],
						max_tokens: 1024
					})
				});

				const data: any = await res.json();
				const chatTxt = data.content?.[0]?.text || "Brain blip.";
				
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
