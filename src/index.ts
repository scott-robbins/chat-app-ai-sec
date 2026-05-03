import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const CALENDAR_TRUTH = `UVA 2026-2027: Fall starts Aug 25, 2026. Reading Days Oct 3-6. Thanksgiving Nov 25-29. Fall ends Dec 8. Spring starts Jan 20, 2027. Recess March 6-14. Spring ends May 4. Finals May 21-23.`;
const SYLLABUS_TRUTH = `CS 4750 Syllabus: Advisor Dr. Thomas Jefferson (Thornton Hall 1743). MID-TERM EXAM TOPICS: Cloudflare Vectorize, Durable Objects (D1), and KV Store architecture. Mid-term Date: March 24, 2026 (Rice Hall Auditorium). Tradition: Victory Bagel at Bodo’s Bagels. Success ID: WAHOO-AI-DEEP-RECALL.`;
const PERSONAL_GROUND_TRUTH = `Identity: Scott Robbins, Senior Solutions Engineer at Cloudflare. Named after dog Jolene. Scott and Renee named the dog after the Ray LaMontagne song 'Jolene' they heard while watching the credits roll for the movie 'THE TOWN'. Dogs: Jolene and Hanna. Teams: Celtics, Patriots, UFC.`;

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
			return `Live Web Intel (May 2026): \n\n` + data.results?.map((r: any) => `${r.title}: ${r.content}`).join("\n\n");
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
				activeQuiz: !!activePool,
				durableObject: { id: sessionId, state: "Active" }
			}), { headers });
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();
				await this.saveMsg(sessionId, 'user', userMsg);
				const sessionState = await this.ctx.storage.get("session_state");

				// --- RESTORED: KV PREFERENCE Toggles ---
				if (lowMsg.includes("fancy mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Fancy Mode");
					const res = "I've updated your profile to **Fancy Mode**. Refresh the page to see the UI update!";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}
				if (lowMsg.includes("plain mode")) {
					await this.env.SETTINGS.put(`view_preference`, "Plain Mode");
					const res = "Understood. I've switched your profile to **Plain Mode**. Refresh to see the dashboard change.";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("stop quiz") || lowMsg === "stop") {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("quiz_score");
					await this.ctx.storage.delete("current_q_idx");
					await this.ctx.storage.delete("session_state");
					const res = "### 🛑 Quiz Stopped\nI've reset your learning state. What else can I help you with, Scott?";
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (sessionState === "WAITING_FOR_ANSWER") {
					const pool = await this.ctx.storage.get("quiz_pool") as any[];
					const qIdx = await this.ctx.storage.get("current_q_idx") as number || 0;
					let score = await this.ctx.storage.get("quiz_score") as number || 0;
					const currentQ = pool[qIdx];
					
					const isCorrect = lowMsg.startsWith(currentQ.hidden_answer.toLowerCase());
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					
					const feedback = isCorrect ? "✅ **Correct!**" : `❌ **Incorrect.** The correct answer was **${currentQ.hidden_answer}**.`;
					const explanation = await this.runAI(body.model || DEFAULT_CF_MODEL, "Explain the calendar date.", `Question: ${currentQ.q} Answer: ${currentQ.hidden_answer} Context: ${CALENDAR_TRUTH}`);

					if (qIdx + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", qIdx + 1);
						const next = pool[qIdx + 1];
						const combined = `${feedback}\n\n${explanation}\n\n---\n### Question ${qIdx + 2} of 5\n**${next.q}**\n\n${next.options.join('\n')}`;
						await this.saveMsg(sessionId, 'assistant', combined);
						return new Response(`data: ${JSON.stringify({ response: combined })}\n\ndata: [DONE]\n\n`);
					} else {
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.ctx.storage.delete("quiz_score");
						const final = `${feedback}\n\n${explanation}\n\n### 🏁 Quiz Complete!\n**Final Score: ${score}/5**`;
						await this.saveMsg(sessionId, 'assistant', final);
						return new Response(`data: ${JSON.stringify({ response: final })}\n\ndata: [DONE]\n\n`);
					}
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("test me")) return this.initQuizPool(sessionId, body.model || DEFAULT_CF_MODEL);

				if (sessionState === "WAITING_FOR_NEWS_CONFIRM" && (lowMsg.includes("yes") || lowMsg.includes("sure"))) {
					await this.ctx.storage.delete("session_state");
					const news = await this.tavilySearch("University of Virginia UVA campus news May 2026");
					const res = await this.runAI(body.model || DEFAULT_CF_MODEL, "Summarize UVA news warmly.", news);
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const res = `### 🎓 UVA Mode: Full Study Companion Activated\nI am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia materials.\n\n**What I can do for you now:**\n* **Practice Quizzes**: Grounded in your UVA documents.\n* **Syllabus Analysis**: Extracting exam dates and grading policies.\n\n**Would you like me to fetch the latest UVA campus news and events for you?**`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const res = `### 🏠 Personal Mode: Real-Time Assistant Activated\nI have switched to your general Personal Assistant mode.\n\n**What I can do for you now:**\n* **Real-Time Web Search**: I use **Tavily Search** for news and stocks.\n* **Cross-Document Access**: Access to personal documents (tax, family notes).\n\n*Note: This mode is best for real-time information.*`;
					await this.saveMsg(sessionId, 'assistant', res);
					return new Response(`data: ${JSON.stringify({ response: res })}\n\ndata: [DONE]\n\n`);
				}

				const activeMode = (await this.env.SETTINGS.get(`active_mode`)) || "personal";
				let liveContext = "";
				if (lowMsg.includes("stock") || lowMsg.includes("weather") || lowMsg.includes("news")) {
					if (activeMode === "personal" || lowMsg.includes("uva")) liveContext = await this.tavilySearch(userMsg);
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 12, filter: { segment: "personal" }, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n\n");
				
				const systemPrompt = `You are Jolene, Scott Robbins' dedicated assistant. Professional and helpful. Today is Sunday, May 3, 2026.
STRICT NAMESAKE: Named after dog Jolene. Scott and Renee named her after the Ray LaMontagne song they heard while watching the movie credits roll for 'THE TOWN'.
STRICT ARCHITECTURE: Mid-term topics are: Cloudflare Vectorize, Durable Objects (D1), and KV Store.
MODE: ${activeMode.toUpperCase()}
SOURCES:
${liveContext ? `LIVE WEB: ${liveContext}` : ''}
${docContext ? `DOCUMENTS: ${docContext.substring(0, 4000)}` : ''}
GROUND TRUTH: ${PERSONAL_GROUND_TRUTH} | ${activeMode === 'uva' ? SYLLABUS_TRUTH + CALENDAR_TRUTH : 'DISABLED'}`;

				const historyRes = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 6").bind(sessionId).all();
				const chatTxt = await this.runAI(body.model || DEFAULT_CF_MODEL, systemPrompt, userMsg, historyRes.results?.reverse() || []);
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);
			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Alert: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string, model: string) {
		const prompt = `FACTS: ${CALENDAR_TRUTH}\nTASK: Generate 5 MCQs about specific UVA Calendar dates. Return ONLY raw JSON array: [{"q":"Question?","options":["A. Date","B. Date","C. Date","D. Date"],"hidden_answer":"A"}]`;
		const raw = await this.runAI(model, "JSON ONLY.", prompt);
		const pool = JSON.parse(raw.substring(raw.indexOf('['), raw.lastIndexOf(']') + 1));
		await this.ctx.storage.put("quiz_pool", pool);
		await this.ctx.storage.put("current_q_idx", 0);
		await this.ctx.storage.put("quiz_score", 0);
		await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
		const res = `### 🎓 UVA Quiz Started (Type 'Stop Quiz' to exit)\n**${pool[0].q}**\n\n${pool[0].options.join('\n')}`;
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
