import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// 1. THE DURABLE OBJECT CLASS (Must be exported for the module to be valid)
// =====================================================================
export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/history" && request.method === "GET") {
			const savedMessages = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: savedMessages }), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = (await request.json()) as { messages: ChatMessage[], image?: string };
				const { messages = [], image } = body;
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// --- ART GENERATION: CLEAN BASE64 ---
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const imageResponse = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt });
					
					const bytes = new Uint8Array(imageResponse);
					let binary = "";
					for (let i = 0; i < bytes.byteLength; i++) {
						binary += String.fromCharCode(bytes[i]);
					}
					const base64Image = btoa(binary).replace(/\s/g, "");
					
					return new Response(JSON.stringify({ 
						image: `data:image/png;base64,${base64Image}`,
						prompt: prompt
					}), { headers: { "Content-Type": "application/json" } });
				}

				// --- STANDARD CHAT LOGIC ---
				await this.ctx.storage.put("messages", messages);
				let activeModel = await this.env.CHAT_CONFIG.get("active_model") || DEFAULT_MODEL;
				let sysPrompt = await this.env.CHAT_CONFIG.get("system_prompt") || "You are a helpful assistant.";

				if (!image) {
					try {
						const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
						const searchResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
						if (searchResults.matches.length > 0 && searchResults.matches[0].score > 0.5) {
							sysPrompt += `\n\nContext: ${searchResults.matches[0].metadata?.text}`;
						}
					} catch (e) {}
				}

				const sysIdx = messages.findIndex((msg) => msg.role === "system");
				if (sysIdx === -1) messages.unshift({ role: "system", content: sysPrompt });
				else messages[sysIdx].content = sysPrompt;

				const aiPayload: any = { messages, max_tokens: 1024, stream: true };
				if (image && image.includes(",")) {
					activeModel = DEFAULT_MODEL;
					const base64Data = image.split(",")[1];
					const bytes = new Uint8Array(atob(base64Data).split("").map(c => c.charCodeAt(0)));
					aiPayload.image = Array.from(bytes);
				}

				const stream = await this.env.AI.run(activeModel, aiPayload);
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });

			} catch (error: any) {
				return new Response(JSON.stringify({ error: error.message }), { status: 500 });
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}

// 2. THE MAIN WORKER ROUTER (Default Export)
// =====================================================================
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		if (url.pathname === "/api/config" && request.method === "GET") {
			const model = await env.CHAT_CONFIG.get("active_model") || DEFAULT_MODEL;
			return new Response(JSON.stringify({ model }), { 
				status: 200, headers: { "Content-Type": "application/json" } 
			});
		}

		if (url.pathname === "/api/set-model") {
			const newModel = url.searchParams.get("name");
			if (newModel) {
				await env.CHAT_CONFIG.put("active_model", newModel);
				return new Response(`Success! Brain swapped to: ${newModel}`, { status: 200 });
			}
			return new Response("Please provide a model name.", { status: 400 });
		}

		if (url.pathname === "/api/set-prompt") {
			const newPrompt = url.searchParams.get("text");
			if (newPrompt) {
				await env.CHAT_CONFIG.put("system_prompt", newPrompt);
				return new Response(`Success! Jolene's personality is now: "${newPrompt}"`, { status: 200 });
			}
			return new Response("Please provide a prompt text.", { status: 400 });
		}

		if (url.pathname === "/api/agree") {
			try {
				await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" });
				return new Response("Successfully agreed to Meta License!", { status: 200 });
			} catch (error: any) {
				return new Response("Error: " + error.message, { status: 500 });
			}
		}

		if (url.pathname === "/api/upload" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				if (!file) return new Response("No file provided", { status: 400 });
				const fileName = file.name;
				let fileText = "";
				if (fileName.toLowerCase().endsWith(".pdf")) {
					const arrayBuffer = await file.arrayBuffer();
					await env.DOCUMENTS.put(fileName, arrayBuffer);
					const result = await (env.AI as any).toMarkdown({ name: fileName, blob: new Blob([arrayBuffer]) });
					const parsedDoc = Array.isArray(result) ? result[0] : result;
					fileText = parsedDoc.data;
				} else {
					fileText = await file.text(); 
					await env.DOCUMENTS.put(fileName, fileText);
				}
				const chunks = fileText.split("\n\n").filter(c => c.trim().length > 20);
				const vectorsToInsert = [];
				for (let i = 0; i < chunks.length; i++) {
					const chunkText = chunks[i].trim();
					const embedding = await env.AI.run(EMBEDDING_MODEL, { text: [chunkText] });
					vectorsToInsert.push({ id: `${fileName}-chunk-${i}`, values: embedding.data[0], metadata: { text: chunkText, source: fileName } });
				}
				await env.VECTORIZE.insert(vectorsToInsert);
				return new Response(JSON.stringify({ success: true, message: `Saved ${fileName}` }), { status: 200 });
			} catch (error: any) {
				return new Response(JSON.stringify({ error: error.message }), { status: 500 });
			}
		}

		if (url.pathname === "/api/chat" || url.pathname === "/api/history") {
			const sessionId = request.headers.get("x-session-id");
			if (!sessionId) return new Response("Missing Session ID", { status: 400 });
			const id = env.CHAT_SESSION.idFromName(sessionId);
			const stub = env.CHAT_SESSION.get(id);
			return stub.fetch(request);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
