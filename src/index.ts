import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

// NEW IMPORTS FOR PDF PARSING
import { Buffer } from "node:buffer";
import pdf from "pdf-parse";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// =====================================================================
// 1. THE MAIN WORKER ROUTER
// =====================================================================
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// ==========================================
		// KV: CONFIGURATION ROUTES (Model & Prompt)
		// ==========================================
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

		if (url.pathname === "/api/seed") {
			try {
				const companyKnowledge = [
					"The secret Wi-Fi password for the guest lobby is 'OrangeFlamingo2026'.",
					"Project Nebula is a highly confidential, AI-powered coffee machine."
				];
				const embeddings = await env.AI.run(EMBEDDING_MODEL, { text: companyKnowledge });
				const vectorsToInsert = companyKnowledge.map((text, index) => ({
					id: `knowledge-doc-${index}`,
					values: embeddings.data[index],
					metadata: { text: text }
				}));
				await env.VECTORIZE.insert(vectorsToInsert);
				return new Response("Multiple secrets successfully injected into Vectorize!", { status: 200 });
			} catch (error: any) {
				return new Response("Error seeding database: " + error.message, { status: 500 });
			}
		}

		// ==========================================
		// R2 & VECTORIZE: DOCUMENT UPLOAD ROUTE
		// ==========================================
		if (url.pathname === "/api/upload" && request.method === "POST") {
			try {
				const formData = await request.formData();
				const file = formData.get("file") as File;
				if (!file) return new Response("No file provided", { status: 400 });

				const fileName = file.name;
				let fileText = "";

				// 1. Check if the file is a PDF or a standard text file
				if (fileName.toLowerCase().endsWith(".pdf")) {
					// Convert the file to a Node.js Buffer for the pdf-parse library
					const arrayBuffer = await file.arrayBuffer();
					const buffer = Buffer.from(arrayBuffer);
					
					// Extract the text from the PDF
					const pdfData = await pdf(buffer);
					fileText = pdfData.text;

					// Save the original binary PDF safely into R2
					await env.DOCUMENTS.put(fileName, arrayBuffer);
				} else {
					// It's a normal text file
					fileText = await file.text(); 
					// Save the original text file safely into R2
					await env.DOCUMENTS.put(fileName, fileText);
				}

				// 2. Simple Chunking (Split by double line breaks)
				const chunks = fileText.split("\n\n").filter(c => c.trim().length > 20);

				// 3. Embed each chunk and save to Vectorize
				const vectorsToInsert = [];
				for (let i = 0; i < chunks.length; i++) {
					const chunkText = chunks[i].trim();
					const embedding = await env.AI.run(EMBEDDING_MODEL, { text: [chunkText] });
					
					vectorsToInsert.push({
						id: `${fileName}-chunk-${i}`,
						values: embedding.data[0],
						metadata: { text: chunkText, source: fileName }
					});
				}

				await env.VECTORIZE.insert(vectorsToInsert);

				return new Response(JSON.stringify({ 
					success: true, 
					message: `Successfully saved ${fileName} to R2 and memorized ${chunks.length} chunks of text!` 
				}), { status: 200, headers: { "Content-Type": "application/json" } });

			} catch (error: any) {
				return new Response(JSON.stringify({ error: "Upload failed: " + error.message }), { status: 500 });
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

// =====================================================================
// 2. THE DURABLE OBJECT CLASS
// =====================================================================
export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/history" && request.method === "GET") {
			const savedMessages = await this.ctx.storage.get<ChatMessage[]>("messages") || [];
			return new Response(JSON.stringify({ messages: savedMessages }), {
				headers: { "Content-Type": "application/json" }
			});
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
				await this.ctx.storage.put("messages", messages);

				let activeModel = await this.env.CHAT_CONFIG.get("active_model");
				if (!activeModel) activeModel = DEFAULT_MODEL;

				let baseSystemPrompt = await this.env.CHAT_CONFIG.get("system_prompt");
				if (!baseSystemPrompt) {
					baseSystemPrompt = "You are a helpful, friendly assistant. Provide concise and accurate responses.";
				}

				const latestMessage = messages[messages.length - 1]?.content || "";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [latestMessage] });
				
				const searchResults = await this.env.VECTORIZE.query(queryVector.data[0], {
					topK: 1, returnMetadata: "all"
				});

				let dynamicSystemPrompt = baseSystemPrompt;
				if (searchResults.matches.length > 0 && searchResults.matches[0].score > 0.5) {
					const foundContext = searchResults.matches[0].metadata?.text;
					dynamicSystemPrompt += `\n\nUse this internal context to answer the user: ${foundContext}`;
				}

				const sysIdx = messages.findIndex((msg) => msg.role === "system");
				if (sysIdx === -1) {
					messages.unshift({ role: "system", content: dynamicSystemPrompt });
				} else {
					messages[sysIdx].content = dynamicSystemPrompt;
				}

				const stream = await this.env.AI.run(
					activeModel, 
					{
						messages, 
						max_tokens: 1024, 
						stream: true,
					},
					{
						gateway: {
							id: "ai-sec-gateway",
							skipCache: false,
							cacheTtl: 3600,
						}
					}
				);

				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: "Failed to process request" }), { status: 500 });
			}
		}

		return new Response("Method not allowed", { status: 405 });
	}
}
