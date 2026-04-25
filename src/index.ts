import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const CONVERSATION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct"; 
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; 

export class ChatSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

	// --- HELPER: RELIABLE D1 SQL PERSISTENCE ---
	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) {
			console.error("D1 Persistence Error:", e);
		}
	}

	// --- HELPER: TAVILY WEB SEARCH ---
	async tavilySearch(query: string) {
		try {
			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${query} (current year 2026)`, 
					search_depth: "advanced",
					include_answer: true,
					max_results: 5
				})
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join("\n\n") || "No real-time web results found.";
		} catch (e) {
			console.error("Tavily Error:", e);
			return "Web search is currently unavailable.";
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		// --- 1. PERSISTENCE: D1 HISTORY LOADER ---
		if (url.pathname === "/api/history") {
			try {
				const history = await this.env.jolene_db.prepare(
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		// --- 2. COMMAND CENTER SYNC ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 100").bind(sessionId).all();
				const storage = await this.env.DOCUMENTS.list();
				const activePool = await this.ctx.storage.get("quiz_pool");

				return new Response(JSON.stringify({ 
					profile: "Scott E Robbins | Senior Solutions Engineer", 
					messages: history.results || [],
					messageCount: stats?.total || 0,
					knowledgeAssets: storage.objects.map(o => o.key), 
					mode: activeMode,
					activeQuiz: !!activePool,
					durableObject: { id: sessionId, state: "Active", location: "Cloudflare Edge" }
				}), { headers });
			} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers }); }
		}

		// --- 3. CHAT ENGINE (WITH HYBRID SEARCH & MODES) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);

				// --- FEATURE: MODE SWITCHING ---
				if (lowMsg.includes("switch to uva mode") || lowMsg.includes("change mode to uva")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = `### 🎓 UVA Mode: Full Study Companion Activated
I am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia documents and academic materials.

**What I can do for you now:**
- **Practice Quizzes**: I generate 5-question sessions grounded in your UVA documents. Say **'Start the UVA Academic Calendar Quiz'** to begin.
- **Syllabus Analysis**: I can extract exam dates and grading policies from your uploads.
- **Academic Tutoring**: I strictly follow your academic files.

*Note: In this mode, I do not access personal files or the live web.*`;
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode") || lowMsg.includes("change mode to personal")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const personalRes = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched to your general Personal Assistant mode. I now have broader access to help with your daily life.

**What I can do for you now:**
- **Real-Time Web Search**: I use **Tavily Search** for current sports scores, news, and weather.
- **Cross-Document Access**: I can access your personal documents (tax info, family notes) in addition to academic files.
- **General Inquiries**: I leverage the live web for up-to-the-minute information.

*Note: This mode is best for real-time information and personal organization.*`;
					await this.saveMsg(sessionId, 'assistant', personalRes);
					return new Response(`data: ${JSON.stringify({ response: personalRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- FEATURE: STOP QUIZ ---
				if (lowMsg === "stop quiz" || lowMsg === "exit quiz") {
					await this.ctx.storage.delete("quiz_pool");
					await this.ctx.storage.delete("session_state");
					await this.ctx.storage.delete("current_q_idx");
					await this.ctx.storage.delete("quiz_score");
					const stopRes = "### 🛑 Quiz Stopped\nI've cleared the session. I'm still in UVA mode and ready for your document questions!";
					await this.saveMsg(sessionId, 'assistant', stopRes);
					return new Response(`data: ${JSON.stringify({ response: stopRes })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				// A. STATE: QUIZ GRADING
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const userLetter = lowMsg[0].toUpperCase();
					const correctLetter = currentQ.hidden_answer.toUpperCase();
					const isCorrect = userLetter === correctLetter;
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					const correctText = currentQ.options[correctLetter.charCodeAt(0) - 65];

					const graderPrompt = `USER: ${userLetter}, CORRECT: ${correctLetter}, RESULT: ${isCorrect ? 'Correct' : 'Incorrect'}, FACT: "${correctText}". Explain using 'you' and ask "Ready for question ${index + 2}?" if not last.`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are Jolene, a UVA Tutor." }, { role: "user", content: graderPrompt }] });
					let gradeTxt = gradeRun.response || gradeRun;

					if (index + 1 < pool.length) {
						if (!gradeTxt.includes(`question ${index + 2}`)) gradeTxt += `\n\nReady for question ${index + 2}?`;
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						gradeTxt += `\n\n### 🏁 Quiz Complete!\n**Final score: ${score}/5.**`;
						await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state");
					}
					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING "CONTINUE"
				const isContinue = /^(yes|yea|yep|y|sure|ready|next|continue|ok|k|yers|go)/i.test(lowMsg);
				if (sessionState === "WAITING_FOR_CONTINUE" && isContinue) {
					const nextQ = pool[index];
					await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
					const optionsLines = nextQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt}`).join('\n');
					const uiRes = `### 📝 Question ${index + 1} of 5\n**${nextQ.q}**\n\n${optionsLines}\n\n*Reply A, B, or C!*`;
					await this.saveMsg(sessionId, 'assistant', uiRes);
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- 4. CORE ENGINE: RAG + REAL-TIME SEARCH ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let webContext = "";
				let docContext = "";

				if (activeMode === 'personal') {
					// HYBRID PERSONAL: Web + All Docs
					webContext = await this.tavilySearch(userMsg);
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				} else {
					// STRICT UVA: Only Study Docs (No Web)
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar " + userMsg] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: "uva" }, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz")) return this.initQuizPool(sessionId);

				const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: `Identity: Jolene. Mode: ${activeMode}. Current Date: ${today}. Always address user as 'you'. 
						PERSONAL MODE: You have access to the live web and all documents. Use web results for current events/sports.
						UVA MODE: You are a Study Companion. Access ONLY UVA documents.
						If web results contain the Celtics schedule for April 2026, it is CURRENT information. Do NOT say you only have data until 2025.` }, 
						{ role: "user", content: `WEB SEARCH CONTEXT:\n${webContext}\n\nDOCUMENT CONTEXT:\n${docContext}\n\nQUESTION: ${userMsg}` }
					] 
				});
				const chatTxt = chatRun.response || chatRun;
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: Fall 2026 starts Aug 25. Thanksgiving Nov 25-29. Registrar (434) 982-5300. Founded 1819. Classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. Raw JSON array: [{"q":"...","options":["..."],"hidden_answer":"A"}].`;
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "JSON API" }, { role: "user", content: prompt }] });
			let raw = typeof quizGen.response === 'string' ? quizGen.response : JSON.stringify(quizGen.response || quizGen);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); if (!jsonMatch) throw new Error("Pool error");
			const pool = JSON.parse(jsonMatch[0]);
			await this.ctx.storage.put("quiz_pool", pool); await this.ctx.storage.put("current_q_idx", 0); await this.ctx.storage.put("quiz_score", 0); await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
			const firstQ = pool[0];
			const uiRes = `### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${firstQ.options.map((o:string,i:number)=>`${['A','B','C'][i]}. ${o}`).join('\n')}\n\n*Reply A, B, or C!*`;
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Quiz Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
