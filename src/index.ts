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

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				const token = (this.env.IMAGES_TOKEN || "").trim();
				const accountId = (this.env.ACCOUNT_ID || "3746ba19913534b7653b8af6a1299286").trim();

				// 1. UPLOAD (We know this works based on your dashboard)
				const directRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`, {
					method: "POST", headers: { "Authorization": `Bearer ${token}` }
				});
				const directData = await directRes.json() as any;
				const uploadFormData = new FormData();
				uploadFormData.append("file", file);
				const uploadRes = await fetch(directData.result.uploadURL, { method: "POST", body: uploadFormData });
				const imgResult = await uploadRes.json() as any;
				const imageUrl = imgResult.result.variants[0];

				// 2. THE AI HANDOFF (The likely breaking point)
				// We fetch the 'public' variant Cloudflare just made. 
				// We don't resize. We don't slice. We just get the clean bytes.
				const aiImageFetch = await fetch(imageUrl);
				if (!aiImageFetch.ok) throw new Error("AI could not fetch the stored image variant.");
				const imageBuffer = await aiImageFetch.arrayBuffer();

				const vision = await this.env.AI.run(CONVERSATION_MODEL, {
					messages: [{
						role: "user",
						content: [
							{ type: "text", text: "Identify the dogs: Jolene (black/tan) and Hanna (red). Describe briefly." },
							{ type: "image", image: [...new Uint8Array(imageBuffer)] }
						]
					}]
				}, { gateway: GATEWAY_ID });

				const description = vision.response || "Image uploaded and stored.";

				// 3. VECTORIZE
				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [description] }, { gateway: GATEWAY_ID });
				await this.env.VECTORIZE.insert([{
					id: crypto.randomUUID(),
					values: emb.data[0],
					metadata: { text: description, fileName: file.name, sessionId, imageUrl }
				}]);

				return new Response(JSON.stringify({ description }), { headers: { "Content-Type": "application/json" } });
			} catch (err: any) {
				return new Response(JSON.stringify({ error: err.message }), { status: 500 });
			}
		}

		// Simplified Chat for testing
		if (url.pathname === "/api/chat" && request.method === "POST") {
			const body = await request.json() as any;
			const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: body.messages }, { gateway: GATEWAY_ID });
			return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
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
