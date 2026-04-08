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

		// --- MEMORIZE ROUTE ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				let textToIndex = "";
				let imageUrl = "";

				if (file.type.startsWith("image/")) {
					const token = (this.env.IMAGES_TOKEN || "").trim();
					const accountId = (this.env.ACCOUNT_ID || FALLBACK_ACCOUNT_ID).trim();

					// Prepare the upload specifically for the v4/images API
					const imgUploadData = new FormData();
					
					// Important: Convert to arrayBuffer then to a Part for the FormData
					const arrayBuffer = await file.arrayBuffer();
					const filePart = new Uint8Array(arrayBuffer);
					
					// Use a very standard filename to avoid parsing errors
					imgUploadData.append("file", new Blob([filePart], { type: "image/png" }), "image.png");

					const cfImage = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`, {
						method: "POST",
						headers: { 
							"Authorization": `Bearer ${token}`
						},
						body: imgUploadData
					});

					const imgResult = await cfImage.json() as any;

					if (!cfImage.ok || !imgResult.result) {
						const msg = imgResult.errors?.[0]?.message || "Invalid Input Structure";
						throw new Error(`Cloudflare Images: ${msg} (Code: ${imgResult.errors?.[0]?.code})`);
					}

					// Get the first variant URL
					imageUrl = imgResult.result.variants[0]; 

					// Now fetch it back resized for Llama Vision
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const imageBuffer = await aiImageRes.arrayBuffer();

					// THIS should now show up in AI Gateway
					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image for a memory database. Be thorough." },
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

		// --- CHAT ROUTE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestUserMessage = body.messages[body.messages.length - 1].content;
				
				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				const profileUpdate = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Identity: "${currentProfile}"\nFact: "${latestUserMessage}"\nUpdate concise identity or return exact.`
				}, { gateway: GATEWAY_ID });

				if (profileUpdate.response && profileUpdate.response !== currentProfile) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdate.response);
				}

				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Need search? YES/NO: ${latestUserMessage}` }, { gateway: GATEWAY_ID });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { searchResults = await this.searchWeb(latestUserMessage); }

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] }, { gateway: GATEWAY_ID });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Identity: ${profileUpdate.response}\nContext: ${contextText}\nSearch: ${searchResults}` },
						...body.messages
					]
				}, { gateway: GATEWAY_ID });

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// --- HELPERS ---
		if (url.pathname === "/api/profile") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`);
			const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").bind(sessionId).first();
			return new Response(JSON.stringify({ profile: profile || "No profile.", messageCount: stats?.count || 0 }), { headers: { "Content-Type": "application/json" } });
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
