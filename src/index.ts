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

		// --- ANALYTICS HELPER ---
		const logMetric = (action: string, value: number = 1) => {
			this.env.JOLENE_METRICS.writeDataPoint({
				blobs: [action, sessionId, CONVERSATION_MODEL],
				doubles: [value, Date.now() - startTime],
				indexes: [sessionId]
			});
		};

		// --- PROACTIVE MONITOR ---
		if (url.pathname === "/api/monitor-task" && request.method === "POST") {
			const profile = await this.env.SETTINGS.get(`global_user_profile`) || "AI and Technology";
			const lastNews = await this.env.SETTINGS.get(`last_monitored_news`) || "";
			const searchResults = await this.searchWeb(`Latest critical breaking news for: ${profile}`);
			
			const analysis = await this.env.AI.run(REASONING_MODEL, {
				prompt: `Last News: "${lastNews}"\nNew Search: "${searchResults}"\nTask: Is this NEW? If yes, 2-sentence alert. If no, "NO_UPDATE".`
			});

			if (analysis.response && !analysis.response.includes("NO_UPDATE")) {
				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", `🔔 **Proactive Alert:** ${analysis.response}`).run();
				await this.env.SETTINGS.put(`last_monitored_news`, analysis.response);
				logMetric("proactive_alert");
			}
			return new Response("OK");
		}

		// --- MEMORIZE WITH CLOUDFLARE IMAGES ---
		if (url.pathname === "/api/memorize" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				let textToIndex = "";
				let imageUrl = "";

				if (file.type.startsWith("image/")) {
					// 1. Upload to Cloudflare Images
					const imgFormData = new FormData();
					imgFormData.append("file", file);
					
					const cfImage = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.ACCOUNT_ID}/images/v1`, {
						method: "POST",
						headers: { "Authorization": `Bearer ${this.env.IMAGES_TOKEN}` },
						body: imgFormData
					});
					const imgResult = await cfImage.json() as any;
					imageUrl = imgResult.result.variants[0]; 

					// 2. Vision analysis using a low-res variant for stability
					const aiImageRes = await fetch(imageUrl + "/width=800,height=800,fit=scale-down");
					const blob = await aiImageRes.arrayBuffer();

					const vision = await this.env.AI.run(CONVERSATION_MODEL, {
						messages: [
							{ role: "user", content: [
								{ type: "text", text: "Describe this image for a searchable memory database." },
								{ type: "image", image: [...new Uint8Array(blob)] }
							]}
						]
					});
					textToIndex = vision.response || "Image uploaded.";
					logMetric("image_processed");
				} else {
					textToIndex = await file.text();
					logMetric("document_processed");
				}

				// 3. Vector Indexing
				const emb = await this.env.AI.run(EMBEDDING_MODEL, { text: [textToIndex] });
				await this.env.VECTORIZE.insert([{ 
					id: crypto.randomUUID(), 
					values: emb.data[0], 
					metadata: { text: textToIndex, fileName: file.name, sessionId, imageUrl } 
				}]);

				return new Response(JSON.stringify({ description: textToIndex }), { headers: { "Content-Type": "application/json" } });
			} catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
		}

		// --- CHAT WITH AUTO-IDENTITY & ANALYTICS ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const latestUserMessage = body.messages[body.messages.length - 1].content;
				
				// Identity sidecar
				const currentProfile = await this.env.SETTINGS.get(`global_user_profile`) || "";
				const profileUpdate = await this.env.AI.run(REASONING_MODEL, {
					prompt: `Identity: "${currentProfile}"\nNew Fact: "${latestUserMessage}"\nUpdate Identity concisely (150 chars max) or return exactly if no new facts.`
				});
				if (profileUpdate.response && profileUpdate.response !== currentProfile) {
					await this.env.SETTINGS.put(`global_user_profile`, profileUpdate.response);
					logMetric("identity_updated");
				}

				// Search logic
				const searchIntent = await this.env.AI.run(REASONING_MODEL, { prompt: `Need web search? "YES" or "NO" for: ${latestUserMessage}` });
				let searchResults = "";
				if (searchIntent.response?.includes("YES")) { 
					searchResults = await this.searchWeb(latestUserMessage); 
					logMetric("web_search");
				}

				// RAG logic
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
				const contextText = matches.matches.map(m => m.metadata.text).join("\n\n");

				// Generate Final Response
				const chatRun = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `You are Jolene. Identity: ${profileUpdate.response}\nContext: ${contextText}\nSearch: ${searchResults}` },
						...body.messages
					]
				});

				await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
					.bind(sessionId, "assistant", chatRun.response).run();

				logMetric("chat_processed", chatRun.response.length);
				return new Response(`data: ${JSON.stringify({ response: chatRun.response })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
		}

		// (Add standard routes for /api/profile, /api/history, /api/files as before)
		return new Response("Not Allowed", { status: 405 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const id = env.CHAT_SESSION.idFromName("global");
		const obj = env.CHAT_SESSION.get(id);
		ctx.waitUntil(obj.fetch(new Request("http://jolene.internal/api/monitor-task", { method: "POST" })));
	}
} satisfies ExportedHandler<Env>;
