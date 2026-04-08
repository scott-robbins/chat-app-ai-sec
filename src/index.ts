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

		// --- CHAT ROUTE (Restoring PDF Reading/Search) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestMsg = body.messages[body.messages.length - 1].content;

				// 1. RAG: Search the Vector Database for PDF context
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMsg] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				
				// Combine the found facts from your documents
				const contextText = matches.matches.map(m => m.metadata?.text || "").join("\n\n");

				// 2. Identity & Theme
				const currentTheme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
				const profile = await this.env.SETTINGS.get(`global_user_profile`) || "A helpful assistant.";

				// 3. Generate Response with Context
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ 
							role: "system", 
							content: `You are Jolene. Theme: ${currentTheme}. User Profile: ${profile}.
							Use the following context from uploaded documents to answer the user's question. 
							If the context contains a specific date like March 13th, use it.
							Context: ${contextText}` 
						},
						...body.messages
					]
				}, { gateway: GATEWAY_ID });

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response, theme: currentTheme })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- MEMORIZE (Storage only to keep it stable) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const token = (this.env.IMAGES_TOKEN || "").trim();
				const accountId = (this.env.ACCOUNT_ID || "3746ba19913534b7653b8af6a1299286").trim();

				if (file.type.startsWith("image/")) {
					// Storage logic we know works
					const directRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`, {
						method: "POST", headers: { "Authorization": `Bearer ${token}` }
					});
					const directData = await directRes.json() as any;
					const uploadFormData = new FormData();
					uploadFormData.append("file", file);
					await fetch(directData.result.uploadURL, { method: "POST", body: uploadFormData });

					return new Response(JSON.stringify({ description: "Image saved to gallery. Vision analysis is currently paused for stability." }));
				} else {
					// Document indexing logic (For PDFs/Text)
					const text = await file.text();
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [text] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text, fileName: file.name, sessionId } 
					}]);
					return new Response(JSON.stringify({ description: "Document memorized successfully." }));
				}
			} catch (err: any) { return new Response(JSON.stringify({ error: "Memory snag, but file may have saved." })); }
		}

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			const theme = await this.env.SETTINGS.get(`global_theme`) || "fancy";
			return new Response(JSON.stringify({ messages: results, theme }), { headers: { "Content-Type": "application/json" } });
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
