/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE), now augmented with 
 * Cloudflare Vectorize for Retrieval-Augmented Generation (RAG).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Model ID for text embeddings (used by Vectorize)
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// ==========================================
		// VECTORIZE SEED ROUTE (Upgraded for Multiple Secrets)
		// ==========================================
		if (url.pathname === "/api/seed") {
			try {
				// We can now add as many secrets to this array as we want!
				const companyKnowledge = [
					"The secret Wi-Fi password for the guest lobby is 'OrangeFlamingo2026'.",
					"Project Nebula is a highly confidential, AI-powered coffee machine scheduled to launch in Q3 2026. Its standout feature is biometric profile recognition."
				];
				
				// 1. Turn the entire array of text into vector embeddings all at once
				const embeddings = await env.AI.run(EMBEDDING_MODEL, {
					text: companyKnowledge
				});

				// 2. Map the data into the format Vectorize expects
				const vectorsToInsert = companyKnowledge.map((text, index) => ({
					id: `knowledge-doc-${index}`, // Creates unique IDs: knowledge-doc-0, knowledge-doc-1
					values: embeddings.data[index],
					metadata: { text: text }
				}));

				// 3. Bulk insert them into Vectorize
				await env.VECTORIZE.insert(vectorsToInsert);

				return new Response("Multiple secrets successfully injected into Vectorize! You can now close this tab.", { status: 200 });
			} catch (error: any) {
				return new Response("Error seeding database: " + error.message, { status: 500 });
			}
		}
		// ==========================================

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// ==========================================
		// VECTORIZE RAG LOGIC
		// ==========================================
		// Get the user's latest question
		const latestMessage = messages[messages.length - 1]?.content || "";

		// 1. Turn the user's question into a vector
		const queryVector = await env.AI.run(EMBEDDING_MODEL, {
			text: [latestMessage]
		});

		// 2. Search Vectorize for similar information
		const searchResults = await env.VECTORIZE.query(queryVector.data[0], {
			topK: 1, // Get the single best match
			returnMetadata: "all"
		});

		// 3. If we find a good match, inject it into the System Prompt
		let dynamicSystemPrompt = SYSTEM_PROMPT;
		
		// If the score is higher than 0.5, the AI found a highly relevant match in our database
		if (searchResults.matches.length > 0 && searchResults.matches[0].score > 0.5) {
			const foundContext = searchResults.matches[0].metadata?.text;
			dynamicSystemPrompt += `\n\nUse this internal context to answer the user: ${foundContext}`;
		}

		// Update or add the system prompt in the messages array
		const sysIdx = messages.findIndex((msg) => msg.role === "system");
		if (sysIdx === -1) {
			messages.unshift({ role: "system", content: dynamicSystemPrompt });
		} else {
			messages[sysIdx].content = dynamicSystemPrompt;
		}
		// ==========================================

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
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
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
