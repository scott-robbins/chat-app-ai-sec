import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/toggle-maintenance") {
			const currentState = await env.CHAT_CONFIG.get("is_maintenance_mode");
			const newState = currentState === "true" ? "false" : "true";
			await env.CHAT_CONFIG.put("is_maintenance_mode", newState);
			return new Response(`Success! Maintenance mode is now: ${newState.toUpperCase()}`, { status: 200 });
		}

		const isMaintenance = await env.CHAT_CONFIG.get("is_maintenance_mode");
		if (isMaintenance === "true") {
			if (url.pathname.startsWith("/api/")) {
				return new Response(JSON.stringify({ error: "Jolene is currently getting an upgrade. Be right back! 🛠️" }), { 
					status: 503, headers: { "Content-Type": "application/json" } 
				});
			}
			return new Response(`
				<!DOCTYPE html>
				<html>
				<head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
				<body style="display:flex; justify-content:center; align-items:center; height:100vh; background-color:#0f172a; color:#f8fafc; font-family:sans-serif; text-align:center; margin:0; padding:20px;">
					<div>
						<h1 style="color:#f6821f; font-size:2.5rem; margin-bottom:10px;">Jolene is Offline</h1>
						<p style="font-size:1.2rem; color:#cbd5e1;">We are currently upgrading the system. Please check back in a few minutes! 🛠️</p>
					</div>
				</body>
				</html>
			`, { status: 503, headers: { "Content-Type": "text/html" } });
		}

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
				return new Response(`Success! The bot's personality is now: "${newPrompt}"`, { status: 200 });
			}
			return new Response("Please provide a prompt.", { status: 400 });
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
					if (parsedDoc.format === "error") throw new Error("Cloudflare AI failed to parse PDF");
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
				return new Response(JSON.stringify({ success: true, message: `Successfully memorized ${fileName}` }), { status: 200 });
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
				const { messages = [], image } = (await request.json()) as { messages: ChatMessage[], image?: string };
				const latestUserMessage = messages[messages.length - 1]?.content || "";

				// --- IMAGE GENERATION LOGIC ---
				if (latestUserMessage.toLowerCase().startsWith("/imagine ")) {
					const prompt = latestUserMessage.slice(9);
					const imageResponse = await this.env.AI.run("@cf/google/gemini-3-flash-image", { prompt });
					const binaryString = String.fromCharCode(...new Uint8Array(imageResponse));
					const base64Image = btoa(binaryString);
					
					return new Response(JSON.stringify({ 
						image: `data:image/png;base64,${base64Image}`,
						description: `Generated: "${prompt}"` 
					}), { headers: { "Content-Type": "application/json" } });
				}

				// --- STANDARD CHAT LOGIC ---
				await this.ctx.storage.put("messages", messages);
				let activeModel = await this.env.CHAT_CONFIG.get("active_model") || DEFAULT_MODEL;
				let baseSystemPrompt = await this.env.CHAT_CONFIG.get("system_prompt") || "You are a helpful assistant.";

				let dynamicSystemPrompt = baseSystemPrompt;
				if (!image) {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestUserMessage] });
					const searchResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 1, returnMetadata: "all" });
					if (searchResults.matches.length > 0 && searchResults.matches[0].score > 0.5) {
						dynamicSystemPrompt += `\n\nContext: ${searchResults.matches[0].metadata?.text}`;
					}
				}

				const sysIdx = messages.findIndex((msg) => msg.role === "system");
				if (sysIdx === -1) messages.unshift({ role: "system", content: dynamicSystemPrompt });
				else messages[sysIdx].content = dynamicSystemPrompt;

				const aiPayload: any = { messages, max_tokens: 1024, stream: true };
				if (image) {
					const base64Data = image.split(",")[1];
					const bytes = new Uint8Array(atob(base64Data).split("").map(c => c.charCodeAt(0)));
					aiPayload.image = Array.from(bytes);
				}

				const stream = await this.env.AI.run(activeModel, aiPayload, { gateway: { id: "ai-sec-gateway", skipCache: false, cacheTtl: 3600 } });
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			} catch (error) {
				return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
			}
		}
		return new Response("Not allowed", { status: 405 });
	}
}
