import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const REASONING_MODEL = "@cf/meta/llama-3.1-70b-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async searchWeb(query: string): Promise<string> {
		try {
			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY,
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
					
					// Clean the token and ID
					const token = (this.env.IMAGES_TOKEN || "").trim();
					const accountId = (this.env.ACCOUNT_ID || "3746ba19913534b7653b8af6a1299286").trim();

					const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`;
					
					// IMPORTANT: Do NOT set Content-Type header manually here.
					// Let the fetch API generate the boundary for the FormData.
					const cfImage = await fetch(uploadUrl, {
						method: "POST",
						headers: { 
							"Authorization": `Bearer ${token}`
						},
						body: imgFormData
					});

					const imgResult = await cfImage.json() as any;

					if (!cfImage.ok || !imgResult.result) {
						console.error("Images API Error:", imgResult);
						const apiMsg = imgResult.errors?.[0]?.message || "Unknown Auth Error";
						const apiCode = imgResult.errors?.[0]?.code || "N/A";
						throw new Error(`Cloudflare Images Error: ${apiMsg} (Code: ${apiCode}) for ID: ${accountId.substring(0, 6)}...`);
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
					});
					textToIndex = vision.response || "Analyzed.";
				} else {
					textToIndex = await file.text();
				}

				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [textToIndex] });
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

		// --- SUPPORTING ROUTES ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			const lastMsg = await this.env.jolene_db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").bind(sessionId).first();
			const thinkingAbout = lastMsg?.content ? (lastMsg.content as string).substring(0, 35) + "..." : "Ready to assist";

			return new Response(JSON.stringify({ 
				profile: profile || "No profile.",
				messageCount: stats?.count || 0,
				thinkingAbout: thinkingAbout
			}), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			const body = await request.json() as any;
			const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { messages: body.messages });
			return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
		}

		return new Response("Not Allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
