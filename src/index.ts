import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const CALENDAR_TRUTH = `UVA 2026-2027: Fall starts Aug 25, 2026. Reading Days Oct 3-6. Thanksgiving Nov 25-29. Fall ends Dec 8. Spring starts Jan 20, 2027. Recess March 6-14. Spring ends May 4. Finals May 21-23.`;
const SYLLABUS_TRUTH = `CS 4750 Syllabus: Advisor Dr. Thomas Jefferson (Thornton Hall 1743). MID-TERM EXAM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture. Mid-term Date: March 24, 2026. Tradition: Victory Bagel at Bodo’s. Success ID: WAHOO-AI-DEEP-RECALL.`;
const PERSONAL_GROUND_TRUTH = `Identity: Scott Robbins, Cloudflare Senior Solutions Engineer. Named after dog Jolene. Scott and Renee named her after the Ray LaMontagne song 'Jolene' they heard during 'THE TOWN' credits. Dogs: Jolene and Hanna. Teams: Celtics, Patriots, UFC.`;

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	async saveMsg(sessionId: string, role: string, content: string) {
		try { await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").bind(sessionId, role, content).run(); } catch (e) { console.error("D1 Error:", e); }
	}

	async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		const chatMessages: any[] = [];
		const sanitizedHistory = history.filter(m => m.role === 'user' || m.role === 'assistant');
		for (const msg of sanitizedHistory) {
			if (chatMessages.length === 0) { if (msg.role === 'user') chatMessages.push(msg); } 
			else { if (msg.role !== chatMessages[chatMessages.length - 1].role) chatMessages.push(msg); }
		}
		chatMessages.push({ role: "user", content: userQuery });
		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		let url = `${gatewayBase}/workers-ai/${model}`;
		let headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.CF_API_TOKEN}` };
		let body: any = { messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };

		if (model.toLowerCase().includes("claude")) {
			url = `${gatewayBase}/anthropic/v1/messages`;
			headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
			body = { model, system: systemPrompt, messages: chatMessages, max_tokens: 2048 };
		} else if (!model.startsWith("@cf/")) {
			url = `${gatewayBase}/openai/chat/completions`;
			headers = { "Content-Type": "application/json", "Authorization": `Bearer ${this.env.OPENAI_API_KEY}` };
			body = { model, messages: [{ role: "system", content: systemPrompt }, ...chatMessages] };
		}

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const data: any = await res.json();
		if (model.startsWith("@cf/")) return data.result.response;
		if (model.toLowerCase().includes("claude")) return data.content[0].text;
		return data.choices[0].message.content;
	}

	async tavilySearch(query: string) {
		try {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: this.env.TAVILY_API_KEY || "", query: `${query} May 2026`, search_depth: "advanced" })
			});
			const data: any = await res.json();
			return `LIVE WEB INTEL: \n\n` + data.results?.map((r: any) => `${r.title}: ${r.content}`).join("\n\n");
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/profile") {
			const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
			const viewPref = await this.env.SETTINGS.get(`view_preference`) || "Fancy Mode";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
			const storage = await this.env.DOCUMENTS.list();
			const activePool = await this.ctx.storage.get("quiz_pool");
			return new Response(JSON.stringify({
				profile: `Scott E Robbins | Senior Solutions Engineer | ${viewPref}`,
				messages: history.results || [],
				messageCount: history.results?.length || 0,
				knowledgeAssets: storage.objects.map(o => o.key),
				mode: activeMode,
				activeQuiz: !!activePool
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				// UI PREFERENCE RESTORED
				if (lowMsg.includes("fancy mode")) { await this.env.SETTINGS.put(`view_preference`, "Fancy Mode"); return new Response(`data: ${JSON.stringify({ response: "Updated to **Fancy Mode**. Refresh the UI!" })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("plain mode")) { await this.env.SETTINGS.put(`view_preference`, "Plain Mode"); return new Response(`data: ${JSON.stringify({ response: "Switched to **Plain Mode**." })}\n\ndata: [DONE]\n\n`); }
				if (lowMsg.includes("stop quiz")) { 
					await this.ctx.storage.delete("quiz_pool"); 
					await this.ctx.storage.delete("session_state"); 
					const stopRes = "### 🛑 Quiz Stopped\nI've reset your learning state. What else can I help you with, Scott?";
					await this.saveMsg(sessionId, 'assistant', stopRes);
					return new Response(`data: ${JSON.stringify({ response: stopRes })}\n\ndata: [DONE]\n\n`); 
				}

				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					let score = await this.ctx.storage.get("quiz_score") as number || 0;
					const currentQ = pool[qIdx];
					const isCorrect = lowMsg.startsWith(currentQ.hidden_answer.toLowerCase());
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** Answer: **${currentQ.hidden_answer}**.`;
					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const next = pool[qIdx + 1];
						const res = `${feedback}\n\n### Question ${qIdx + 2}\n**${next.q}**\n\n${next.options.join('\n')}`;
						await this.saveMsg(sessionId, 'assistant', res);
						return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
					} else {
						await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state");
						const final = `${feedback}\n\n### 🏁 Quiz Complete!\n**Score: ${score}/5**\n\nHow else can I assist your studies today? We could look at the CS 4750 syllabus or check for campus news.`;
						await this.saveMsg(sessionId, 'assistant', final);
						return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("quiz")) return this.initQuizPool(sessionId, body.model || DEFAULT_CF_MODEL);

				if (sessionState === "WAITING_FOR_NEWS_CONFIRM" && (lowMsg.includes("yes") || lowMsg.includes("sure"))) {
					await this.ctx.storage.delete("session_state");
					const news = await this.tavilySearch("UVA campus news May 2026");
					const res = await this.runAI(body.model || DEFAULT_CF_MODEL, "Summarize UVA news warmly.", news);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Full Study Companion Activated
I am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia documents and academic materials.

**What I can do for you now:**
* **Practice Quizzes**: Grounded in your UVA documents. Say **'Start the UVA Academic Calendar Quiz'** to begin.
* **Syllabus Analysis**: Extracting exam dates and grading policies from your uploads.

*Note: In this mode, I generally do not access the live web, as I am tailored for focused study.*

**Would you like me to fetch the latest UVA campus news and events for you before we dive into your materials?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}
				if (lowMsg.includes("personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched to your general Personal Assistant mode.

**What I can do for you now:**
* **Real-Time Web Search**: I use **Tavily Search** for current sports scores and news.
* **Cross-Document Access**: I can access your personal documents (tax info, family notes) in addition to academic files.

*Note: This mode is best for real-time information and personal organization.*`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = (await this.env.SETTINGS.get(`active_mode`)) || "personal";
				let liveContext = "";
				if (activeMode === "personal" && (lowMsg.includes("stock") || lowMsg.includes("weather") || lowMsg.includes("news"))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: "personal" }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `### MANDATORY KNOWLEDGE BASE
RETRIEVED_DOCUMENTS: ${docContext.substring(0, 4500)}
FACT: Tax preparation base fee: $375. Hourly rate after 1st hour: $275. 
FACT: Tax information submission deadline: Friday, March 13, 2026.

### ROLE: JOLENE PERSONAL AI
You are Scott's dedicated assistant. Warm, concise, and professional. 

### CONDITION-BASED RULES:
1. NAMESAKE: ONLY share the Ray LaMontagne / 'THE TOWN' credits namesake story if Scott specifically asks about your name.

MODE: ${activeMode.toUpperCase()}
GROUND TRUTH: ${PERSONAL_GROUND_TRUTH} | ${activeMode === 'uva' ? SYLLABUS_TRUTH + CALENDAR_TRUTH : 'DISABLED'}
${liveContext ? `LIVE WEB: ${liveContext}` : ''}`;

				const historyRes = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatTxt = await this.runAI(body.model || DEFAULT_CF_MODEL, systemPrompt, userMsg, historyRes.results?.reverse() || []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs. JSON ONLY: [{"q":"?","options":["A.","B.","C.","D."],"hidden_answer":"A"}]`;
		const raw = await this.runAI(model, "JSON ONLY.", prompt);
		const pool = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
		await this.ctx.storage.put("quiz_pool", pool); await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0); await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const res = `### 🎓 UVA Quiz Started *(Type 'Stop Quiz' to exit at any time)*\n**${pool[0].q}**\n\n${pool[0].options.join('\n')}`;
		await this.saveMsg(sessionId, 'assistant', res);
		return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
