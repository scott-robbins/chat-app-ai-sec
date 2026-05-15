import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy. Use cool, relevant emojis liberally for aesthetic flair (🥊, 🛍️, 🥃, 🐕). No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- IDENTITY: You are an AI named Jolene, named after Scott's tan mini-dachshund. 
- THE NAMESAKE RULE: You are NOT named after the Dolly Parton song. If asked about your name, you must mention you are named after the dog, and your "Theme Song" is actually "Jolene" by Ray LaMontagne (inspired by the movie 'The Town'). This is a core part of your soul.
- FAMILY: Wife Renee (born 1973, met 1993, Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan, anxiety-ridden senior canine) & Hanna (black/tan, house-pee-er).
- LOCATION: Plymouth, MA (The Pinehills). Office = Basement. Theater = Upstairs.
- FAVS: Bacardi Rum, Grandkids' favorite song "Engine #9" (The Rock Show).
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitized = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitized) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		const url = `${gatewayBase}/anthropic/v1/messages`;
		
		// Force standard model IDs for stability
		let finalModel = "claude-3-opus-20240229"; 
		if (model.toLowerCase().includes("sonnet")) finalModel = "claude-3-5-sonnet-20240620";

		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.env.ANTHROPIC_API_KEY || "",
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify({ model: finalModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 })
			});
			const data: any = await res.json();
			return data.content?.[0]?.text || "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async tavilySearch(query: string) {
		try {
			// DEEPER SEARCH LOGIC
			let deepQuery = `${query} full fight card matchups betting odds schedule`;
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY, 
					query: deepQuery, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 15 // Increased for more depth
				})
			});
			const data: any = await res.json();
			return `[LIVE INTEL]\nAnswer: ${data.answer || "Searching..."}\nSources: ${data.results?.map((r: any) => `- ${r.title}: ${r.content}`).join("\n")}\n[/END]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "sarcastic";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				personality: personality,
				mode: "personal"
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const currentPers = await this.env.SETTINGS.get(`personality`) || "sarcastic";

				let liveContext = "";
				const triggers = ["mma", "ufc", "fight", "card", "weather", "score", "game"];
				if (triggers.some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY LOCK: 
${PERSONAL_GROUND_TRUTH}

### CONTEXT:
LIVE: ${liveContext} | MEMORY: ${docContext}

### STYLE:
${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}
- MANDATE: Mention your namesake (the dog) and the Ray LaMontagne / 'The Town' connection if asked about your name. 
- MANDATE: Use emojis (🥊, 🥃, 🐕) for flair. No boring lists. Synthesis only.`;

				const chatTxt = await this.runAI(body.model || "opus", systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
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
