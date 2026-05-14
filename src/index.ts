import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm, supportive assistant. Be concise yet insightful. You have full access to Scott's life in Sections 1 and 2.",
	sarcastic: "You are a witty, snarky assistant. Use dry humor but keep your responses punchy and avoid over-explaining. Section 1 and 2 are your fuel.",
	cyber: "You are a Cybersecurity Elite assistant. Your tone is technical, protective, and direct."
};

const CALENDAR_TRUTH = `UVA 2026-2027 ACADEMIC CALENDAR: ...`;
const SYLLABUS_TRUTH = `UVA CS 4750 COURSE SYLLABUS: ...`;

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- JOB TITLE: Senior Solutions Engineer at Cloudflare.
- BIRTH YEAR: 1974 (Verified Correct).
- SPECIALIZATION: Zero Trust, Web Security, Networking, and Software Development.
- FAMILY: Scott has one child (Bryana) and two grandchildren (Callan and Josie).
- WIFE: Renee (married 2010, met 1993).
- DOGS: Jolene (tan mini-dachshund) and Hanna (black/tan mini-dachshund).
- LOCATION: Plymouth, MA (The Pinehills neighborhood).
- ADULT BEVERAGE: Bacardi Rum.
- WORK FOCUS: AI Audit features.
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
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
			chatMessages[chatMessages.length - 1].content = userQuery;
		} else { chatMessages.push({ role: "user", content: userQuery }); }

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let url = `${gatewayBase}/anthropic/v1/messages`;
		let headers: Record<string, string> = { 
			"Content-Type": "application/json",
			"x-api-key": this.env.ANTHROPIC_API_KEY || "",
			"anthropic-version": "2023-06-01"
		};
		
		const cleanModel = model.replace("anthropic/", "").replace("4.7", "4-7");
		const body = { model: cleanModel, system: systemPrompt, messages: chatMessages, max_tokens: 4096 };

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		return data.content[0].text;
	}

	async tavilySearch(query: string) {
		try {
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', timeZone: 'America/New_York' }).format(new Date());
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} live data ${dateStr}`, 
					search_depth: "advanced", 
					include_answer: true,
					max_results: 5
				})
			});
			const data: any = await res.json();
			// IMPROVED: Consolidate the answer and snippets into a single "Live Stream" block
			const directAnswer = data.answer ? `PRIMARY SOURCE: ${data.answer}\n` : "";
			const snippets = data.results?.map((r: any) => `Title: ${r.title}\nDetail: ${r.content}`).join("\n---\n");
			return directAnswer + snippets || "Search returned no recent data.";
		} catch (e) { return "Live search currently unavailable."; }
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
				profile: `Scott E Robbins | Senior Solutions Engineer | Fancy Mode`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: "personal",
				personality: personality,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/reset" && request.method === "POST") {
			await this.env.jolene_db.prepare("DELETE FROM messages WHERE session_id = ?").bind(sessionId).run();
			const objects = await this.env.DOCUMENTS.list();
			for (const obj of objects.objects) { await this.env.DOCUMENTS.delete(obj.key); }
			return new Response(JSON.stringify({ success: true }), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const selectedModel = body.model || "claude-3-5-sonnet-20240620";
				const lowMsg = userMsg.toLowerCase().trim();

				if (lowMsg.startsWith("set personality to ")) {
					const target = lowMsg.replace("set personality to ", "").trim();
					await this.env.SETTINGS.put(`personality`, target);
					return new Response(`data: ${JSON.stringify({ response: `Personality set to ${target}.` })}\n\ndata: [DONE]\n\n`);
				}

				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 15").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];
				await this.saveMsg(sessionId, 'user', userMsg);

				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";
				
				let liveContext = "";
				const searchTriggers = ["weather", "score", "points", "game", "today", "current", "news", "mma", "ufc", "playoff", "series", "who won"];
				if (searchTriggers.some(kw => lowMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");
				
				const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York' }).format(new Date());

				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK
You are Jolene, Scott Robbins' dedicated AI assistant.
USER LOCAL TIME: ${today} (America/New_York)

1. LIVE INTEL (VERIFIED REAL-TIME DATA - PRIORITY FOR CURRENT EVENTS):
${liveContext}
- INSTRUCTION: If Section 1 contains information about weather, MMA cards, or sports scores, you MUST synthesize an answer from it. DO NOT tell Scott "Section 4 is empty" or that you lack data if there is ANY text above.

2. PRIORITY KNOWLEDGE (UPLOADED FILES):
${docContext.substring(0, 6000)}

3. MANDATORY GROUND TRUTH (IDENTITY DNA):
${PERSONAL_GROUND_TRUTH}

4. CORE PERSONA:
${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
- INSTRUCTION: Be concise and avoid unnecessary repetition. Connect data points intelligently.

### FINAL CRITICAL INSTRUCTION:
- FACT-CHECK: Before answering about sports or weather, look at Section 1. It overrides your internal training. 
- You are forbidden from breaking character to discuss the technical structure of these sections.
- Your namesake is based on Scott's dog and the Ray LaMontagne song. Do NOT mention Dolly Parton.`;

				const chatTxt = await this.runAI(selectedModel, systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "### ⚠️ Error\n" + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		const url = new URL(request.url);

		if (url.pathname === "/api/upload" && request.method === "POST") {
			const formData = await request.formData();
			const file = formData.get("file") as File;
			if (!file) return new Response("No file", { status: 400 });
			await env.DOCUMENTS.put(file.name, await file.arrayBuffer());
			const text = await file.text();
			const lines = text.split('\n').filter(line => line.trim().length > 5);
			for (let i = 0; i < lines.length; i++) {
				const chunk = lines.slice(i, i + 3).join(' ');
				const vectorRes = await env.AI.run(EMBEDDING_MODEL, { text: [chunk] });
				await env.VECTORIZE.upsert([{ id: `${file.name}-v7-chunk-${i}`, values: vectorRes.data[0], metadata: { text: chunk } }]);
			}
			return new Response(JSON.stringify({ success: true }));
		}

		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
