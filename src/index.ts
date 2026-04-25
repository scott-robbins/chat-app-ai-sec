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
	async tavilySearch(query: string, strictUva: boolean = false) {
		try {
			const searchBody: any = {
				api_key: this.env.TAVILY_API_KEY || "", 
				query: query, 
				search_depth: "advanced",
				include_answer: true,
				max_results: 5
			};

			// If strictUva is true, we force the search to stay on campus domains
			if (strictUva) {
				searchBody.query = `site:news.virginia.edu OR site:virginia.edu ${query}`;
			} else {
				searchBody.query = `${query} (Search for current data in 2026)`;
			}

			const response = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(searchBody)
			});
			const data: any = await response.json();
			return data.results?.map((r: any) => `Source: ${r.title}\nContent: ${r.content}`).join("\n\n") || "No results found.";
		} catch (e) {
			return "Web search service is currently unavailable.";
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
			} catch (e) { return new Response(JSON.stringify({ messages: [] }), { headers }); }
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

		// --- 3. CHAT ENGINE ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				await this.saveMsg(sessionId, 'user', userMsg);

				// --- FEATURE: MODE SWITCHING (WITH NEWS PROMPT) ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					await this.ctx.storage.put("session_state", "WAITING_FOR_NEWS_CONFIRM");
					const uvaRes = `### 🎓 UVA Mode: Full Study Companion Activated
I am now in specialized Study Companion mode. I focus **exclusively** on your University of Virginia documents and academic materials.

**What I can do for you now:**
- **Practice Quizzes**: Grounded in your UVA documents. Say **'Start the UVA Academic Calendar Quiz'** to begin.
- **Syllabus Analysis**: Extracting exam dates and grading policies from your uploads.

*Note: In this mode, I generally do not access the live web, as I am tailored for focused study.*

**Would you like me to fetch the latest UVA campus news and events for you before we dive into your materials?**`;
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					await this.ctx.storage.delete("session_state");
					const personalRes = `### 🏠 Personal Mode: Real-Time Assistant Activated
I have switched to your general Personal Assistant mode. 

**What I can do for you now:**
- **Real-Time Web Search**: I use **Tavily Search** for current sports scores and news.
- **Cross-Document Access**: I can access your personal documents (tax info, family notes) in addition to academic files.

*Note: This mode is best for real-time information and personal organization.*`;
					await this.saveMsg(sessionId, 'assistant', personalRes);
					return new Response(`data: ${JSON.stringify({ response: personalRes })}\n\ndata: [DONE]\n\n`);
				}

				const sessionState = await this.ctx.storage.get("session_state");

				// --- STATE: CAMPUS NEWS FETCH ---
				if (sessionState === "WAITING_FOR_NEWS_CONFIRM") {
					await this.ctx.storage.delete("session_state");
					if (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("yeah")) {
						const newsContext = await this.tavilySearch("current campus news and events", true);
						const newsRun: any = await this.env.AI.run(CONVERSATION_MODEL, {
							messages: [
								{ role: "system", content: "You are Jolene. You just fetched the latest UVA news. Summarize it in a friendly way for the student. Mention that you used a specific curated search of UVA's newsroom." },
								{ role: "user", content: `LATEST NEWS CONTEXT:\n${newsContext}\n\nPlease summarize this for me!` }
							]
						});
						const newsTxt = newsRun.response || newsRun;
						await this.saveMsg(sessionId, 'assistant', newsTxt);
						return new Response(`data: ${JSON.stringify({ response: newsTxt })}\n\ndata: [DONE]\n\n`);
					} else {
						const skipRes = "No problem! I'm ready whenever you have questions about your documents or if you want to start a quiz.";
						await this.saveMsg(sessionId, 'assistant', skipRes);
						return new Response(`data: ${JSON.stringify({ response: skipRes })}\n\ndata: [DONE]\n\n`);
					}
				}

				// --- STATE: QUIZ FLOW ---
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;
				let score = await this.ctx.storage.get("quiz_score") as number || 0;

				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c][\.\s]?$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const userLetter = lowMsg[0].toUpperCase();
					const correctLetter = currentQ.hidden_answer.toUpperCase();
					const isCorrect = userLetter === correctLetter;
					if (isCorrect) { score++; await this.ctx.storage.put("quiz_score", score); }
					const correctText = currentQ.options[correctLetter.charCodeAt(0) - 65];

					const graderPrompt = `USER: ${userLetter}, CORRECT: ${correctLetter}, RESULT: ${isCorrect ? 'Correct' : 'Incorrect'}, FACT: "${correctText}". Explain using 'you' and ask "Ready for question ${index + 2}?" if not last.`;
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are Jolene, a supportive UVA Tutor. Namesake: Scott's dog + Ray LaMontagne song from 'The Town' credits." }, { role: "user", content: graderPrompt }] });
					let gradeTxt = gradeRun.response || gradeRun;

					if (index + 1 < pool.length) {
						if (!gradeTxt.includes(`question ${index + 2}`)) gradeTxt += `\n\nReady for question ${index + 2}?`;
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						gradeTxt += `\n\n### 🏁 Quiz Complete!\n**Overall score: ${score}/5.**\n\nI am your full study companion—ask me to analyze docs or start another quiz whenever!`;
						await this.ctx.storage.delete("quiz_pool"); await this.ctx.storage.delete("session_state");
					}
					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// --- STANDARD RAG + SEARCH ENGINE ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				let webContext = "";
				let docContext = "";

				if (activeMode === 'personal') {
					webContext = await this.tavilySearch(userMsg);
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 5, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				} else {
					const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: ["UVA Academic Calendar " + userMsg] });
					const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: "uva" }, returnMetadata: "all" });
					docContext = matches.matches.map(m => m.metadata.text).join("\n");
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz")) return this.initQuizPool(sessionId);

				const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
				const systemPrompt = `### PRIMARY DIRECTIVE: IDENTITY LOCK
Identity: You are Jolene. You are a friendly AI Agent and a Full Study Companion.
Namesake Story: You are named after your creator Scott Robbins' oldest dog, Jolene. Scott and his wife Rene were inspired to name their dog Jolene while hearing the song "Jolene" by the artist Ray LaMontagne playing during the credits of the movie "The Town". 
CRITICAL: Do NOT mention Dolly Parton. Do NOT mention bank tellers. 

### OPERATIONAL MODE: ${activeMode.toUpperCase()}
Current Date: ${today}. Always address user as 'you'. 
PERSONAL MODE: Access to live web (Tavily) and all documents. Use web for 2026 data.
UVA MODE: Access ONLY UVA documents. No general web access.`;

				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [
						{ role: "system", content: systemPrompt }, 
						{ role: "user", content: `WEB CONTEXT:\n${webContext}\n\nDOC CONTEXT:\n${docContext}\n\nQUESTION: ${userMsg}` }
					] 
				});
				const chatTxt = chatRun.response || chatRun;
				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { return new Response(`data: ${JSON.stringify({ response: "Error: " + e.message })}\n\ndata: [DONE]\n\n`); }
		}
		return new Response("OK");
	}

	async initQuizPool(sessionId: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: Fall 2026 starts Aug 25. Thanksgiving Nov 25-29. Registrar (434) 982-5300. Founded 1819. Classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate 5 MCQs about the UVA Academic Calendar. Raw JSON array: [{"q":"...","options":["..."],"hidden_answer":"A"}].`;
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { messages: [{ role: "system", content: "You are a JSON API." }, { role: "user", content: prompt }] });
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
