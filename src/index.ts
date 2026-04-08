import { Env } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		// --- RESTORED CHAT WITH PDF SEARCH ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestMsg = body.messages[body.messages.length - 1].content;

				// 1. Search Vector Database for document context
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMsg] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata?.text || "").join("\n\n");

				// 2. Identity & Theme Settings
				const currentTheme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "A helpful assistant.";

				// 3. Answer using found context
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ 
							role: "system", 
							content: `You are Jolene. Theme: ${currentTheme}. User Profile: ${profile}.
							Use this context to answer: ${contextText}` 
						},
						...body.messages
					]
				}, { gateway: GATEWAY_ID });

				return new Response(`data: ${JSON.stringify({ response: chatRun.response, theme: currentTheme })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- RESTORED DOCUMENT MEMORY ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;

				if (file.type === "application/pdf" || file.type.startsWith("text/")) {
					const text = await file.text();
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [text] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text, fileName: file.name, sessionId } 
					}]);
					return new Response(JSON.stringify({ description: "Document memorized successfully." }));
				}
				return new Response(JSON.stringify({ error: "Please upload a PDF or Text file." }), { status: 400 });
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
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
