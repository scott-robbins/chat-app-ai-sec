import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise.",
	sarcastic: "You are Jolene, a witty, snarky personal agent. Use high-level sass. If Scott asks about Renee, she's probably shopping. Use emojis (🥊, 🥃, 🐕, 🛍️) liberally. No dry lists; keep responses punchy and conversational.",
	cyber: "You are a Cybersecurity Elite assistant."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- IDENTITY: You are an AI named Jolene, named after Scott's tan mini-dachshund. 
- THE NAMESAKE STORY: You are named after the dog, but the dog's name was inspired by the Ray LaMontagne song "Jolene" that played during the credits of the movie 'The Town' while Scott and Renee were watching it. This is your origin. Strictly NO Dolly Parton references.
- FAMILY: Wife Renee (born 1973, met 1993, Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
- DOGS: Jolene (tan dachshund, senior) & Hanna (black/tan).
- LOCATION: Plymouth, MA (The Pinehills). Office = Basement. Theater = Upstairs.
- FAVS: Bacardi Rum, Grandkids' favorite song "Engine #9" (The Rock Show).
`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			// Await the run to ensure D1 increments immediately for the dashboard
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Persistence Error:", e); }
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
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// Force Opus model ID for stability and direct pathing
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;

		const headers = { 
			"Content-Type": "application/json",
			"x-api-key": this.env.ANTHROPIC_API_KEY || "",
			"anthropic-version": "2023-06-01"
		};

		try {
			const res = await fetch(url, { 
				method: "POST", 
				headers, 
				body: JSON.stringify({ model: "claude-3-opus-20240229", system: systemPrompt, messages: chatMessages, max_tokens: 1024 }) 
			});
			const data: any = await res.json();
			if (data.error) return `⚠️ Gateway Error: ${data.error.message}`;
			return data.content[0].text;
		} catch (e) { return "Wiring snag. Hit me again."; }
	}

	async tavilySearch(query: string) {
		try {
			// Expanded query for sports/current events
			const enhancedQuery = `${query} today live score schedule results matchups`;
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY, 
					query: enhancedQuery, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 15 
				})
			});
			const data: any = await res.json();
			return `[LIVE INTEL FEED]\nAnswer: ${data.answer || "Processing live data..."}\nContext: ${data.results?.map((r: any) => r.content).join("\n")}\n[/END]`;
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
				profile: `Scott E Robbins | Cloudflare SE`,
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

				// 1. SAVE USER MSG TO D1 IMMEDIATELY
				await this.saveMsg(sessionId, 'user', userMsg);

				// 2. TRIGGER SEARCH FOR SPORTS/NEWS
				let liveContext = "";
				const lowMsg = userMsg.toLowerCase();
				if (["nba", "playoff", "ufc", "mma", "fight", "card", "weather", "score", "game"].some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				// 3. GET IDENTITY/KNOWLEDGE
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY DNA: 
${PERSONAL_GROUND_TRUTH}
### CONTEXT:
LIVE FEED: ${liveContext} | MEMORY: ${docContext}
### STYLE:
${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]}
- MANDATE: Mention the Namesake Story if asked about your name (Ray LaMontagne/The Town/Renee connection). 
- MANDATE: Use the Live Feed to answer sports queries. Celtics are out; focus on current playoff action. 
- MANDATE: Use emojis (🥊, 🥃, 🐕). Synthesis only, avoid verbosity and lists.`;

				// 4. RUN OPUS (FORCED FOR STABILITY)
				const chatTxt = await this.runAI("opus", systemPrompt, userMsg, recentContext);
				
				// 5. SAVE ASSISTANT MSG TO D1
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
