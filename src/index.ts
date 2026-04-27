import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) {
				if (msg.role === 'user') chatMessages.push(msg);
			} else {
				if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg);
			}
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		let url = "";
		let headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: any = {};

		if (model.startsWith("@cf/")) {
			url = `${gatewayBase}/workers-ai/${model}`;
			headers["Authorization"] = `Bearer ${this.env.CF_API_TOKEN}`;
			body = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		} else if (model.includes("gpt")) {
			url = `${gatewayBase}/openai/chat/completions`;
			headers["Authorization"] = `Bearer ${this.env.OPENAI_API_KEY}`;
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages], max_tokens: 800 };
		} else if (model.includes("claude")) {
			url = `${gatewayBase}/anthropic/messages`;
			headers["x-api-key"] = this.env.ANTHROPIC_API_KEY;
			headers["anthropic-version"] = "2023-06-01";
			body = { model, max_tokens: 800, system: systemPrompt, messages: chatMessages };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (data.error) throw new Error(`Gateway Error (${model}): ${data.error.message || JSON.stringify(data.error)}`);

		if (model.startsWith("@cf/")) return data.result.response;
		if (model.includes("gpt")) return data.choices[0].message.content;
		if (model.includes("claude")) return data.content[0].text;
		return "Error: Unsupported model.";
	}

	async generateVisual(prompt: string, filename: string) {
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;

		const res = await fetch(`${gatewayBase}/workers-ai/${IMAGE_MODEL}`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ prompt })
		});

		if (!res.ok) {
			const errorBody = await res.text();
			throw new Error(`Visual Engine Error (${res.status}): ${errorBody.substring(0, 100)}`);
		}

		const contentType = res.headers.get("content-type") || "";
		let base64Data = "";

		if (contentType.includes("application/json")) {
			const json: any = await res.json();
			base64Data = json.result?.image || json.image || "";
			const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
			await this.env.DOCUMENTS.put(`visuals/${filename}.png`, binary, { httpMetadata: { contentType: "image/png" } });
		} else {
			const buffer = await res.arrayBuffer();
			await this.env.DOCUMENTS.put(`visuals/${filename}.png`, buffer, { httpMetadata: { contentType: "image/png" } });
			const bytes = new Uint8Array(buffer);
			let binary = "";
			for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
			base64Data = btoa(binary);
		}
		return `data:image/png;base64,${base64Data}`;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");
				return new Response(JSON.stringify({
					profile: "Scott E Robbins | Senior Solutions Engineer",
					messages: history.results || [],
					messageCount: history.results?.length || 0,
					knowledgeAssets: storage.objects.map(o => o.key),
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || DEFAULT_CF_MODEL;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";

				// --- 1. VISUAL STUDY AID HANDLER (ENHANCED DIAGRAM LOGIC) ---
				if (activeMode === "uva" && (lowMsg.includes("visualize") || lowMsg.includes("illustrate") || lowMsg.includes("draw"))) {
					const concept = lowMsg.replace(/visualize|illustrate|draw|show me a diagram|of|the/g, "").trim();
					
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [concept] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: "all" });
					const context = matches.matches.map(m => m.metadata.text).join(" ");

					// IMPROVED PROMPT BRAIN: Focuses on legible technical diagrams
					const systemSpec = "You are a prompt engineer for technical illustrations. Create a prompt for an image model to draw a clean, academic, 2D vector-style diagram.";
					const userSpec = `Create a visualization prompt for: "${concept}". Syllabus Context: ${context}. Requirements: Clean white background, minimalist flat design, professional blue and orange accents (UVA colors), clear distinct nodes and arrows, legible technical labels, no human figures, engineering schematic style.`;
					
					const promptGen = await this.runAI(selectedModel, systemSpec, userSpec);
					
					const imageDataUrl = await this.generateVisual(promptGen, concept.replace(/\s+/g, '_'));
					const resText = `### 🎨 Visual Study Aid: ${concept.toUpperCase()}\nI've generated this technical diagram for **${concept}** based on your syllabus context.\n\n![${concept}](${imageDataUrl})\n\n*This diagram is now archived in your R2 Assets bucket.*`;
					
					await this.saveMsg(sessionId, 'assistant', resText);
					return new Response(`data: ${JSON.stringify({ response: resText })}\n\ndata: [DONE]\n\n`);
				}

				// --- 2. STANDARD CHAT HANDLER ---
				const historyRows = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 4").bind(sessionId).all();
				const chatHistory = (historyRows.results || []).reverse();
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const vectorResults = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
				const docContext = vectorResults.matches.map(m => m.metadata.text).slice(0, 3000).join("\n\n");
				
				const systemPrompt = `Identity: Jolene, Scott Robbins' assistant. Namesake: tan dachshund dog. Mode: ${activeMode}. DOCS: ${docContext}.`;
				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, chatHistory);
				
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "**System Error:** " + e.message })}\n\ndata: [DONE]\n\n`); }
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
