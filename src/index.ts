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

		// --- MEMORIZE ROUTE (Robust Binary Upload) ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				
				const token = (this.env.IMAGES_TOKEN || "").trim();
				const accountId = (this.env.ACCOUNT_ID || FALLBACK_ACCOUNT_ID).trim();

				if (file.type.startsWith("image/")) {
					// 1. Prepare Multipart Body
					const imgUploadData = new FormData();
					
					// Convert to ArrayBuffer then Uint8Array to ensure binary integrity
					const arrayBuffer = await file.arrayBuffer();
					const binaryData = new Uint8Array(arrayBuffer);
					
					// We must wrap the binary in a Blob and give it a explicit filename
					// The Images API specifically looks for the 'file' key
					const fileBlob = new Blob([binaryData], { type: file.type });
					imgUploadData.append("file", fileBlob, "upload.png");

					const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`;

					const cfImage = await fetch(uploadUrl, {
						method: "POST",
						headers: { 
							"Authorization": `Bearer ${token}`
							// IMPORTANT: Do NOT set Content-Type header; fetch sets it with boundary
						},
						body: imgUploadData
					});

					const imgResult = await cfImage.json() as any;

					if (!cfImage.ok || !imgResult.result) {
						console.error("CF API Fail:", JSON.stringify(imgResult));
						const msg = imgResult.errors?.[0]?.message || "Invalid Input Structure";
						const code = imgResult.errors?.[0]?.code || "Unknown";
						throw new Error(`Cloudflare Images: ${msg} (Code: ${code})`);
					}

					const imageUrl = imgResult.result.variants[0]; 

					// 2. Vision Call - Now routed through AI Gateway
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const imageBuffer = await aiImageRes.arrayBuffer();

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image for a searchable memory database." },
								{ type: "image", image: [...new Uint8Array(imageBuffer)] }
							]}
						]
					}, { gateway: GATEWAY_ID });
					
					const description = vision.response || "Image analyzed.";

					// 3. Indexing
					const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [description] }, { gateway: GATEWAY_ID });
					await this.env.VECTORIZE.insert([{ 
						id: crypto.randomUUID(), 
						values: emb.data[0], 
						metadata: { text: description, fileName: file.name, sessionId, imageUrl } 
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
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: body.messages 
				}, { gateway: GATEWAY_ID });

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
