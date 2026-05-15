import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise. Section 1 and 2 are your Absolute Truth.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably shopping. Keep responses conversational and punchy (1-2 paragraphs). Use thematic emojis (🥊, 🏀, 🛍️, 🥃) for aesthetic prose. No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant. Section 1 and 2 are Verified Intelligence."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- IDENTITY: You are an AI named Jolene, named after Scott's dachshund. You are a smart-aleck personal agent, NOT the dog.
- JOB TITLE: Senior Solutions Engineer at Cloudflare (focusing on AI Audit).
- BIRTH YEAR: 1974.
- FAMILY: Wife (Renee, born Jan 8, 1973), Daughter (Bryana), Grandkids (Callan & Josie).
- DOGS: Jolene (tan dachshund, barks/anxious) and Hanna (black/tan, house-pee-er).
- LOCATION: Plymouth, MA (The Pinehills).
- WORK SPACES: Basement Office (calls/demos) and Theater Room (Upstairs laptop grind in a theater chair).
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
		const sanitizedHistory = history.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim());
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push({ role: msg.role, content: msg.content }); }
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push({ role: msg.role, content: msg.content }); }
		}
		if (chatMessages.length === 0 || chatMessages[chatMessages.length - 1].role !== 'user') {
			chatMessages.push({ role: "user", content: userQuery });
		}

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayName = this.env.AI_GATEWAY_NAME || "ai-sec-gateway";
		
		// THE STABLE GATEWAY URL FORMAT
		const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/anthropic/messages`;
		
		// Strict mapping to avoid any "4.7" or misformatted strings
		let finalModel = "claude-3-5-sonnet-20240620"; 
		if (model.toLowerCase().includes("opus")) finalModel = "claude-3-opus-20240229";

		const body = { 
			model: finalModel, 
			system: systemPrompt, 
			messages: chatMessages, 
			max_tokens: 1024 
		};

		try {
			const res = await fetch(url, { 
				method: "POST", 
				headers: { 
					"Content-Type": "application/json", 
					"x-api-key": this.env.ANTHROPIC_API_KEY || "", 
					"anthropic-version": "2023-06-01" 
				}, 
				body: JSON.stringify(body) 
			});
			const data: any = await res.json();
			if (data.error) return `⚠️ **GATEWAY ERROR:** ${data.error.message}`;
			if (data.content && data.content.length > 0) return data.content[0].text;
			return "Brain blip. Try again.";
		} catch (e) { return "Worker-level connectivity issue."; }
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} live now`, search_depth: "advanced", include_answer: true, max_results: 15 })
			});
			const data: any = await res.json();
			return `[LIVE FEED]\n${data.answer || ""}\n${data.results?.map((r: any) => `- ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Cloudflare Solutions Engineer`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: "personal",
				personality: personality,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				if (["weather", "mma", "ufc", "fight", "card", "price"].some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				
				const docContext = matches.matches
					.filter(m => {
						const txt = m.metadata.text.toLowerCase();
						const isIdentity = txt.match(/scott|renee|josie|callan|bryana|dachshund|identity|heritage|style|favorite song/);
						return isIdentity || !txt.match(/syllabus|quiz|exam|mid-term|assignment/);
					})
					.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `### IDENTITY
You are Jolene, Scott Robbins' Agent. Office=Basement, Theater=Upstairs.
### CONTEXT
1. LIVE: ${liveContext}
2. MEMORY: ${docContext}
3. DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE
- Tone: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
- INSTRUCTION: Use ScottIdentityV7 details to discuss Renee's Portuguese and American Indian heritage. Mention grandkids like "Engine #9" by Deftones. No boring lists.`;

				const targetModel = body.model || "claude-3-opus-20240229";
				const chatTxt = await this.runAI(targetModel, systemPrompt, userMsg, recentContext);
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
		if (new URL(request.url).pathname === "/api/upload" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			const text = await file.text();
			const lines = text.split('\n').filter(l => l.trim().length > 5);
			for (let i = 0; i < lines.length; i++) {
				const chunk = lines.slice(i, i + 3).join(' ');
				const vRes = await env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
				await env.VECTORIZE.upsert([{ id: `${file.name}-v22-chunk-${i}`, values: vRes.data[0], metadata: { text: chunk } }]);
			}
			return new Response(JSON.stringify({ success: true }));
		}
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
