import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const FALLBACK_ACCOUNT_ID = "3746ba19913534b7653b8af6a1299286";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				
				const token = (this.env.IMAGES_TOKEN || "").trim();
				const accountId = (this.env.ACCOUNT_ID || FALLBACK_ACCOUNT_ID).trim();

				if (file.type.startsWith("image/")) {
					// 1. Upload high-res for storage
					const directUploadRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`, {
						method: "POST", headers: { "Authorization": `Bearer ${token}` }
					});
					const directData = await directUploadRes.json() as any;
					const uploadFormData = new FormData();
					uploadFormData.append("file", file);
					const uploadRes = await fetch(directData.result.uploadURL, { method: "POST", body: uploadFormData });
					const imgResult = await uploadRes.json() as any;
					const imageUrl = imgResult.result.variants[0]; 

					// 2. FORCE DATA LIMITS FOR THE AI
					// We take the first 60KB of the image. This is enough for the AI to "see" 
					// the dachshunds but small enough to NEVER hit the 128k token limit.
					const arrayBuffer = await file.slice(0, 61440).arrayBuffer();
					const uint8Image = new Uint8Array(arrayBuffer);

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe the two dachshunds here (Jolene is black/tan, Hanna is red)." },
								{ type: "image", image: [...uint8Image] }
							]}
						]
					}, { gateway: GATEWAY_ID });
					
					const description = vision.response || "Dachshunds analyzed.";

					// 3. Indexing
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [description] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: description, fileName: file.name, sessionId, imageUrl: imgResult.result.variants[0] } 
					}]);

					return new Response(JSON.stringify({ description }), { headers: { "Content-Type": "application/json" } });
				}
			} catch (err: any) { 
				return new Response(JSON.stringify({ error: err.message }), { status: 500 }); 
			}
		}

		// --- CHAT ROUTE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: body.messages }, { gateway: GATEWAY_ID });
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();
				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		if (url.pathname === "/api/history") {
			const { results } = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC").bind(sessionId).all();
			return new Response(JSON.stringify({ messages: results }), { headers: { "Content-Type": "application/json" } });
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
