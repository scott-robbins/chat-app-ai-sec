import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const FALLBACK_ACCOUNT_ID = "3746ba19913534b7653b8af6a1299286";
const GATEWAY_ID = "ai-sec-gateway"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const tavilyKey = (this.env.TAVILY_API_KEY || "").trim();
			if (!tavilyKey) return "Search failed: Tavily Key missing.";

			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: tavilyKey,
					query: query,
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data = await response.json() as any;
			return data.answer || data.results.map((r: any) => r.content).join("\n\n");
		} catch (e) { return "Search failed."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const startTime = Date.now();

		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				let textToIndex = "";
				let imageUrl = "";

				if (file.type.startsWith("image/")) {
					const imgFormData = new FormData();
					imgFormData.append("file", file);
					
					const token = (this.env.IMAGES_TOKEN || "").trim();
					const accountId = (this.env.ACCOUNT_ID || FALLBACK_ACCOUNT_ID).trim();

					// DEBUG CHECK: Chat will tell us if token is truly empty
					if (token.length < 5) throw new Error("CRITICAL: IMAGES_TOKEN is empty or too short. Check GitHub/Dashboard Secrets.");

					const cfImage = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`, {
						method: "POST",
						headers: { "Authorization": `Bearer ${token}` },
						body: imgFormData
					});

					const imgResult = await cfImage.json() as any;
					if (!cfImage.ok || !imgResult.result) {
						const apiCode = imgResult.errors?.[0]?.code || "No Code";
						throw new Error(`Cloudflare API Reject (Code: ${apiCode}). Ensure token has 'Images:Edit' permission.`);
					}

					imageUrl = imgResult.result.variants[0]; 
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const imageBuffer = await aiImageRes.arrayBuffer();

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image for a memory database." },
								{ type: "image", image: [...new Uint8Array(imageBuffer)] }
							]}
						]
					}, { gateway: GATEWAY_ID });
					
					textToIndex = vision.response || "Image analyzed.";
				} else {
					textToIndex = await file.text();
				}

				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [textToIndex] }, { gateway: GATEWAY_ID });
				await this.env.VECTORIZE.insert([{ 
					id: crypto.randomUUID(), 
					values: emb.data[0], 
					metadata: { text: textToIndex, fileName: file.name, sessionId, imageUrl } 
				}]);

				return new Response(JSON.stringify({ description: textToIndex }), { headers: { "Content-Type": "application/json" } });
			} catch (err: any) { 
				return new Response(JSON.stringify({ error: err.message }), { status: 500 }); 
			}
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: body.messages 
				}, { gateway: GATEWAY_ID });

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// (Include Profile and History logic as per previous version)
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
