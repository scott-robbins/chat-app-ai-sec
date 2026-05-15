import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, insightful assistant. Section 1 and 2 are your Absolute Truth.",
	sarcastic: "You are Jolene, Scott's witty, high-level snarky personal agent. Use plenty of sass. Reference Scott's wife Renee (the real boss) and the grandkids Callan & Josie. Use emojis (🥊, 🛍️, 🥃, 🏀) liberally. No dry lists; keep it conversational and punchy.",
	cyber: "You are a Cybersecurity Elite assistant. Technical, direct, and elite."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY:
- AI AGENT: Jolene (Named after the dachshund). You are the agent, not the dog.
- CAREER: Senior Solutions Engineer at Cloudflare (AI Audit focus).
- FAMILY: Wife Renee (met 1993, Portuguese/Indian heritage), Daughter Bryana, Grandkids Callan & Josie.
- LOCATION: Plymouth, MA. Office is in the Basement; Theater is Upstairs.
- FAVS: Bacardi Rum, Grandkids' song "Engine #9" (The Rock Show).
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
			if (chatMessages.length === 0) { 
				if (msg.role === 'user') chatMessages.push({role: msg.role, content: msg.content}); 
			} else { 
				if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({role: msg.role, content: msg.content}); 
			}
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		// USE STABLE GATEWAY ENDPOINT
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/v1/messages`;
		
		// Force exact model ID for stability
		let finalModel = "claude-3-opus-20240229"; 

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
			if (data.content && data.content.length > 0) return data.content[0].text;
			return data.error ? `⚠️ AI Error: ${data.error.message}` : "Brain blip. Try again.";
		} catch (e) { return "Wiring snag. Hit me again."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// FIX: RESTORE COMMAND CENTER METRICS
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

				// 1. ADVANCED TAVILY SEARCH (Kept for your fight cards)
				let liveContext = "";
				if (["mma", "ufc", "fight", "card", "weather", "score"].some(kw => userMsg.toLowerCase().includes(kw))) {
					const tRes = await fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query: `${userMsg} ufc mma match schedule odds`, search_depth: "advanced", max_results: 12 })
					});
					const tData: any = await tRes.json();
					liveContext = tData.results?.map((r: any) => r.content).join("\n");
				}

				// 2. VECTOR SEARCH (Top 25 for Identity DNA)
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				const systemPrompt = `### IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}
### STYLE: ${PERSONALITIES[currentPers as keyof typeof PERSONALITIES]} 
INSTRUCTION: Reference Renee's heritage and the kids' favorite song "Engine #9". Use emojis.`;

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
		if (new URL(request.url).pathname === "/api/upload") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
