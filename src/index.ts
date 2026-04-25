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
			console.error("D1 Sync Error:", e);
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
					"SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50"
				).bind(sessionId).all();
				return new Response(JSON.stringify({ messages: history.results || [] }), { headers });
			} catch (e) { 
				return new Response(JSON.stringify({ messages: [] }), { headers }); 
			}
		}

		// --- 2. COMMAND CENTER SYNC (FULL HISTORY RESTORED) ---
		if (url.pathname === "/api/profile") {
			try {
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const stats = await this.env.jolene_db.prepare("SELECT COUNT(*) as total FROM messages WHERE session_id = ?").bind(sessionId).first();
				
				// CRITICAL: Force history reload to fix "Persistent Chat" issue
				const history = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 50").bind(sessionId).all();
				
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

		// --- 3. CHAT ENGINE (WITH 5-QUESTION TUTOR STATE MACHINE) ---
		if (url.pathname === "/api/chat" && request.method === "POST") {
			try {
				const body = await request.json() as any;
				const userMsg = body.messages[body.messages.length - 1].content;
				const lowMsg = userMsg.toLowerCase().trim();

				// IMMEDIATE PERSISTENCE (SAVE USER INPUT)
				await this.saveMsg(sessionId, 'user', userMsg);

				const sessionState = await this.ctx.storage.get("session_state");
				const pool = await this.ctx.storage.get("quiz_pool") as any[];
				const index = await this.ctx.storage.get("current_q_idx") as number || 0;

				// A. STATE: GRADING ANSWER (A, B, or C)
				if (sessionState === "WAITING_FOR_ANSWER" && pool && /^[a-c]$/i.test(lowMsg)) {
					const currentQ = pool[index];
					const graderPrompt = `QUESTION: ${currentQ.q}\nCORRECT_FACT: ${currentQ.hidden_answer}\nUSER_ANSWER: ${userMsg}\n\nTASK: Grade the user. You MUST reference this specific fact: ${currentQ.hidden_answer}. If wrong, explain why. If right, be enthusiastic. If more questions remain, ask "Ready for question ${index + 2}?"`;
					
					const gradeRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
						messages: [{ role: "system", content: "You are the UVA Academic Tutor." }, { role: "user", content: graderPrompt }] 
					});
					const gradeTxt = gradeRun.response || gradeRun;

					if (index + 1 < pool.length) {
						await this.ctx.storage.put("current_q_idx", index + 1);
						await this.ctx.storage.put("session_state", "WAITING_FOR_CONTINUE");
					} else {
						await this.ctx.storage.delete("quiz_pool");
						await this.ctx.storage.delete("session_state");
						await this.ctx.storage.delete("current_q_idx");
					}

					await this.saveMsg(sessionId, 'assistant', gradeTxt);
					return new Response(`data: ${JSON.stringify({ response: gradeTxt })}\n\ndata: [DONE]\n\n`);
				}

				// B. STATE: HANDLING CONTINUE (YES/NEXT)
				if (sessionState === "WAITING_FOR_CONTINUE" && (lowMsg.includes("yes") || lowMsg.includes("sure") || lowMsg.includes("ready") || lowMsg.includes("next"))) {
					const nextQ = pool[index];
					await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");
					
					// FIXED: Force labels A, B, C programmatically
					const optionsLines = nextQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
					const uiRes = `### 📝 Question ${index + 1} of 5\n**${nextQ.q}**\n\n${optionsLines}\n\n*Reply A, B, or C!*`;
					
					await this.saveMsg(sessionId, 'assistant', uiRes);
					return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
				}

				// --- COMMANDS ---
				if (lowMsg.includes("switch to uva mode")) {
					await this.env.SETTINGS.put(`active_mode`, "uva");
					const uvaRes = "### 🎓 UVA Academic Study Companion Activated\nSay 'start a quiz' to begin your 5-question study session.";
					await this.saveMsg(sessionId, 'assistant', uvaRes);
					return new Response(`data: ${JSON.stringify({ response: uvaRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("switch to personal mode")) {
					await this.env.SETTINGS.put(`active_mode`, "personal");
					const pRes = "### 🏠 Personal Assistant Mode Activated";
					await this.saveMsg(sessionId, 'assistant', pRes);
					return new Response(`data: ${JSON.stringify({ response: pRes })}\n\ndata: [DONE]\n\n`);
				}

				if (lowMsg.includes("quiz") || lowMsg.includes("start a quiz")) {
					return this.initQuizPool(sessionId);
				}

				// --- STANDARD RAG CHAT ---
				const activeMode = await this.env.SETTINGS.get(`active_mode`) || "personal";
				const retrievalKey = activeMode === 'personal' ? "tax Scott Robbins" : "UVA Academic Calendar August 25 Registrar";
				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [retrievalKey + " " + userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 10, filter: { segment: activeMode }, returnMetadata: "all" });
				const fileContext = matches.matches.map(m => m.metadata.text).join("\n");
				const historyResults = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 15").bind(sessionId).all();
				
				let sysPrompt = activeMode === 'uva' 
					? `### ROLE: UVA Academic Study Companion. ONLY discuss UVA Academic Calendar. GROUNDING: Courses start Aug 25. Thanksgiving is Nov 25-29. Registrar is (434) 982-5300. LOCK PERSONAL RECORDS.` 
					: `### ROLE: Personal Assistant. Discuss family/tax.`;
				sysPrompt += ` Named after Scott's dog Jolene (Ray LaMontagne song).`;

				const chatRun: any = await this.env.AI.run(CONVERSATION_MODEL, { 
					messages: [{ role: "system", content: sysPrompt }, ...historyResults.results, { role: "user", content: `Context: ${fileContext}\n\nQuestion: ${userMsg}` }] 
				});
				const chatTxt = chatRun.response || chatRun;

				await this.saveMsg(sessionId, 'assistant', chatTxt);
				return new Response(`data: ${JSON.stringify({ response: chatTxt })}\n\ndata: [DONE]\n\n`);

			} catch (e: any) { 
				const err = "System Error: " + e.message;
				await this.saveMsg(sessionId, 'assistant', err);
				return new Response(`data: ${JSON.stringify({ response: err })}\n\ndata: [DONE]\n\n`); 
			}
		}
		return new Response("OK");
	}

	// --- HELPER: INITIALIZE 5-QUESTION QUIZ POOL (HARDENED JSON) ---
	async initQuizPool(sessionId: string): Promise<Response> {
		try {
			const facts = "UVA FACTS: 1. Fall 2026 courses begin Aug 25. 2. Thanksgiving recess is Nov 25-29. 3. Registrar phone is (434) 982-5300. 4. UVA was founded in 1819. 5. First classes began March 25, 1825.";
			const prompt = `${facts}\nTASK: Generate EXACTLY 5 MCQ questions. 
			JSON SCHEMA: [{"q":"Question Text","options":["Option 1","Option 2","Option 3"],"hidden_answer":"A"}]
			RULES: Output ONLY a raw JSON array. NO markdown. No intro.`;
			
			const quizGen: any = await this.env.AI.run(CONVERSATION_MODEL, { 
				messages: [{ role: "system", content: "You are a JSON-only API." }, { role: "user", content: prompt }] 
			});
			
			let raw = typeof quizGen.response === 'string' ? quizGen.response : JSON.stringify(quizGen.response || quizGen);
			const jsonMatch = raw.match(/\[[\s\S]*\]/); // Regex to grab the array
			if (!jsonMatch) throw new Error("AI failed to build question pool.");
			
			const pool = JSON.parse(jsonMatch[0]);
			
			await this.ctx.storage.put("quiz_pool", pool);
			await this.ctx.storage.put("current_q_idx", 0);
			await this.ctx.storage.put("session_state", "WAITING_FOR_ANSWER");

			const firstQ = pool[0];
			// Programmatic label injection to guarantee A, B, C
			const optionsText = firstQ.options.map((opt: string, i: number) => `${['A','B','C'][i]}. ${opt.replace(/^[A-C]\.\s*/, '')}`).join('\n');
			const uiRes = `### 📝 Question 1 of 5\n**${firstQ.q}**\n\n${optionsText}\n\n*Reply with A, B, or C!*`;
			
			await this.saveMsg(sessionId, 'assistant', uiRes);
			return new Response(`data: ${JSON.stringify({ response: uiRes })}\n\ndata: [DONE]\n\n`);
		} catch (e: any) {
			const err = "Quiz Pool Error: " + e.message;
			return new Response(`data: ${JSON.stringify({ response: err })}\n\ndata: [DONE]\n\n`);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.CHAT_SESSION.idFromName(request.headers.get("x-session-id") || "global");
		return env.CHAT_SESSION.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;
