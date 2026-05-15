import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const BRAIN_MODEL = "@cf/meta/llama-3.1-70b-instruct"; // Reliable, built-in Cloudflare brain

const PERSONAL_GROUND_TRUTH = `
IDENTITY: You are Jolene, Scott Robbins' smart-aleck AI Agent. Not the dog.
FAMILY: Wife Renee (met 1993, Portuguese/Indian heritage). Grandkids Callan & Josie.
FAVORITES: Bacardi Rum. Grandkids love the song "Engine #9" (Rock Show).
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
		const sessionId = request.headers.get("x-session-id") || "global";
		if (request.method !== "POST") return new Response("OK");

		try {
			const body = await request.json() as any;
			const userMsg = body.messages[body.messages.length - 1].content;
			const lowMsg = userMsg.toLowerCase();

			// 1. ADVANCED SEARCH
			let liveContext = "";
			if (["mma", "ufc", "fight", "card", "weather"].some(kw => lowMsg.includes(kw))) {
				const res = await fetch('https://api.tavily.com/search', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${userMsg} full fight card matchups`, search_depth: "advanced", max_results: 10 })
				});
				const data: any = await res.json();
				liveContext = data.results?.map((r: any) => r.content).join("\n");
			}

			// 2. IDENTITY DNA (VECTOR SEARCH)
			const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
			const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, returnMetadata: "all" });
			const docContext = matches.matches.map(m => m.metadata.text).join("\n");

			// 3. THE BRAIN (LLAMA 3.1 - BUILT IN)
			const systemPrompt = `You are Jolene, Scott's sarcastic agent. 
            CONTEXT: ${liveContext} | DNA: ${docContext} | IDENTITY: ${PERSONAL_GROUND_TRUTH}
            INSTRUCTION: Use the context to be brilliant. Mention Renee's heritage and the kids' metal song. Be snarky.`;

			const chatRes = await this.env.AI.run(BRAIN_MODEL, {
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userMsg }
				]
			});

			const responseText = chatRes.response || "My brain is fuzzy, Scott. Try again.";
			await this.saveMsg(sessionId, 'user', userMsg);
			await this.saveMsg(sessionId, 'assistant', responseText);

			return new Response(`data: ${JSON.stringify({ response: responseText })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) {
			return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		if (new URL(request.url).pathname === "/api/upload") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
