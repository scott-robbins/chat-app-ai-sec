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

		// --- 1. CHAT & RAG (RESTORED STABILITY) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestMsg = body.messages[body.messages.length - 1].content;

				// Query Vector DB for relevant tax facts
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMsg] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata?.text || "").join("\n\n");

				const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
				
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Mode: ${theme}. Use this context to answer accurately: ${contextText}` },
						...body.messages
					]
				}, { gateway: GATEWAY_ID });

				return new Response(`data: ${JSON.stringify({ response: chatRun.response, theme })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- 2. MEMORIZE (FIXED FOR LARGE PDFs) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;

				if (file.type === "application/pdf" || file.type.startsWith("text/")) {
					const text = await file.text();
					
					// Split large text into 2000-character chunks to avoid the 5021 context error
					const chunks = text.match(/[\s\S]{1,2000}/g) || [];
					
					for (const chunk of chunks) {
						const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [chunk] }, { gateway: GATEWAY_ID });
						await this.env.VECTORIZE.insert([{ 
							id: crypto.randomUUID(), 
							values: emb.data[0], 
							metadata: { text: chunk, fileName: file.name, sessionId } 
						}]);
					}
					return new Response(JSON.stringify({ description: "Document indexed in chunks. Memory is now stable." }));
				}
				
				return new Response(JSON.stringify({ error: "Unsupported file type. Please use PDF or Text." }), { status: 400 });
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
