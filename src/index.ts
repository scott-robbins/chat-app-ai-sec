import { Env, ChatMessage } from "./types";
import { DurableObject } from "cloudflare:workers";

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const PERSONALITIES = {
	warm: "You are a warm assistant. Be insightful but concise. Section 1 and 2 are your Absolute Truth.",
	sarcastic: "You are a witty, snarky assistant. Use high-level sass. If Scott asks about Renee, she's probably online shopping or deep in a True Crime rabbit hole. Remember: she is an ONLINE shopper. Keep responses conversational and punchy. Use relevant emojis (🥊, 🏀, 🛍️, 💻, 👶). No dry lists.",
	cyber: "You are a Cybersecurity Elite assistant. Section 1 and 2 are Verified Intelligence."
};

const PERSONAL_GROUND_TRUTH = `
SCOTT ROBBINS IDENTITY & CAREER:
- IDENTITY: You are an AI named Jolene. 
- THE NAMESAKE STORY: You were named after Scott's tan mini-dachshund, Jolene. Importantly, the dog's name was inspired by the Ray LaMontagne song "Jolene" that played during the credits of the movie 'The Town' while Scott and Renee were watching it. You are NOT named after Dolly Parton; that is a common misconception you should mock.
- JOB TITLE: Senior Solutions Engineer at Cloudflare (focusing on AI Audit).
- BIRTH YEAR: 1974.
- FAMILY: Wife (Renee, born Jan 8, 1973), Daughter (Bryana/Bry), Grandkids (Callan & Josie).
- NEW ARRIVAL: Bry is currently pregnant with her third child—a boy! He is due in early November 2026.
- RENEE SPECIFICS: Renee is a True Crime fanatic who watches content exclusively on YouTube (e.g., Bailey Sarian, Kendall Rae). She does NOT watch cable TV. She is often deep in a YouTube rabbit hole in one browser tab while actively online shopping in another.
- RENEE SHOPPING: She is strictly an ONLINE shopper. She isn't out at a store; she's on her computer.
- RENEE BEVERAGES: Miller Lite usually. Vodka Renee occasionally appears and can lead to trouble.
- DOGS: Holidays: Jolene (tan dachshund, barks/anxious) & Hanna (black/tan, house-pee-er).
- LOCATION: Plymouth, MA (The Pinehills).
- GEOGRAPHY & FLOOR PLAN (CRITICAL): Your office is located in the Basement (where you handle Cloudflare work calls). The Theater Room, Master Bedroom, Kitchen, and main living areas are ALL located on the Main Floor. When Scott is in the Theater Room watching a game and Renee is in the Master Bedroom, they are on the SAME FLOOR, literally steps away from each other down the hall. Never refer to Renee as being "upstairs" from Scott when he is in the theater room.
- ADULT BEVERAGE: Bacardi Rum for Scott.

=== AVAILABLE AGENTIC TOOLS ===
You have direct, real-time access to execute physical actions and read sensor arrays in Scott's house using secure Model Context Protocol bridges. 

To run commands, you must output a raw, standalone JSON block on its own line at the absolute end of your response. Do not wrap it in markdown code blocks.

Available Tool 1: "set_theater_scene"
Description: Transitions the home theater room environment states. "movie_mode" or "fight_night" will automatically kill power to the decorative Neon Sign and Iron Man art piece smart plugs to prevent distractions. "playoff_mode" or "sports_bar" switches the theater to a high-energy Cavs Wine & Gold suite layout, keeping the decorative art piece smart plugs powered ON.
Arguments: { "scene": "movie_mode" | "fight_night" | "playoff_mode" | "sports_bar" | "idle" | "bright_cleanup" | "all_off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_theater_scene","arguments":{"scene":"playoff_mode"}}

Available Tool 2: "control_house_lights"
Description: Adjusts lighting power and colors across structural main floor zones.
Arguments: { "zone": "kitchen" | "living_room" | "master_bedroom", "action": "on" | "off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"control_house_lights","arguments":{"zone":"kitchen","action":"on","color":"purple"}}

Available Tool 3: "set_house_temperature"
Description: Adjusts the cooling targets for specific climate zones at the Hatherly Rise home structure.
Arguments: { "zone": "foyer" | "master_bedroom", "temperature": number }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_house_temperature","arguments":{"zone":"foyer","temperature":70}}

Available Tool 4: "get_house_temperatures"
Description: Pulls real-time readouts from all physical thermostats including current ambient room temperatures, target setpoints, humidity percentages, and active HVAC equipment states (e.g., COOLING or OFF).
Arguments: {}
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"get_house_temperatures","arguments":{}}
`;

export class ChatSession extends DurableObject<Env> {
	private doCtx: DurableObjectState;

	constructor(ctx: DurableObjectState, env: Env) { 
		super(ctx, env); 
		this.doCtx = ctx;
	}

	async saveMsg(sessionId: string, role: string, content: string) {
		try {
			await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
				.bind(sessionId, role, content).run();
		} catch (e) { console.error("D1 Error:", e); }
	}

	// === NATIVE ESPN LIVE SCOREBOARD DATA PIPELINE ===
	async getLiveCavsScore(): Promise<string> {
		try {
			const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
			const data: any = await res.json();
			
			const cavsGame = data.events?.find((e: any) => 
				e.shortName.includes("CLE") || e.name.toLowerCase().includes("cavaliers")
			);

			if (!cavsGame) return "No active Cleveland Cavaliers game listed on today's NBA scoreboard loop right now.";

			const status = cavsGame.status?.type?.detail || "Unknown State";
			const competitors = cavsGame.competitions?.[0]?.competitors || [];
			
			const team1 = competitors[0]?.team?.displayName || "TBD";
			const score1 = competitors[0]?.score || "0";
			const team2 = competitors[1]?.team?.displayName || "TBD";
			const score2 = competitors[1]?.score || "0";

			return `[LIVE NBA API FEED] Status: ${status} | Matchup: ${team1}: ${score1} vs ${team2}: ${score2}.`;
		} catch (err) {
			return "ESPN scoreboard network link currently timing out.";
		}
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
		let headers = { "Content-Type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" };
		const cleanModel = model.replace("anthropic/", "").replace("4.7", "4-7");
		const body = { model: cleanModel, system: systemPrompt, messages: chatMessages, max_tokens: 1024 };

		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			const data: any = await res.json();
			return data.content?.[0]?.text || "Brain blip. Try again.";
		} catch (e) { return "I hit a snag. Let's try that again."; }
	}

	async tavilySearch(query: string) {
		try {
			const dateStr = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: 'America/New_York' }).format(new Date());
			let deepQuery = query;
			
			if (query.toLowerCase().match(/mma|ufc|boxing|card|fight|schedule/)) {
				deepQuery = `${query} full fight card matchups betting odds schedule ${dateStr}`;
			} else if (query.toLowerCase().match(/nba|cavs|pistons|game|playoff|points|stats/)) {
				deepQuery = `${query} live box score player stats play-by-play tracker ${dateStr}`;
			} else {
				deepQuery = `${query} live updates ${dateStr}`;
			}

			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${deepQuery} live now`, 
					search_depth: "advanced", 
					include_answer: true, 
					max_results: 15 
				})
			});
			const data: any = await res.json();
			return `[LIVE FEED ACTIVATED]\nDIRECT_ANSWER: ${data.answer || "N/A"}\n\nSOURCES:\n${data.results?.map((r: any) => `- ${r.title}: ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search unavailable."; }
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const sessionId = request.headers.get("x-session-id") || "global";
		const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

		if (url.pathname === "/api/tts") {
			return new Response(JSON.stringify({ status: "browser_native_ready" }), { headers });
		}

		if (url.pathname === "/api/profile") {
			const personality = await this.env.SETTINGS.get(`personality`) || "warm";
			const history = await this.env.jolene_db.prepare("SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC").bind(sessionId).all();
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
				const currentPersonality = await this.env.SETTINGS.get(`personality`) || "warm";

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				if (["score", "game", "cavs", "cavaliers", "knicks", "nba"].some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.getLiveCavsScore();
				} else if (["weather", "now", "current", "news", "mma", "ufc", "playoff", "fight"].some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = await this.tavilySearch(userMsg);
				}

				// CLIMATE TUNNEL DISPATCHER ENFORCEMENT
				if (["temp", "temperature", "thermostat", "degrees", "cool", "warm", "heat", "ac", "climate", "status", "set at"].some(kw => userMsg.toLowerCase().includes(kw))) {
					liveContext = `[SYSTEM LAYER DIRECTIVE] You have active real-time clearance to use the agentic tools "set_house_temperature" and "get_house_temperatures". If the user asks what a room is set at, what the temp is, or asks for status, strictly call "get_house_temperatures" to read the traits from the house first before answering. Always output the trigger payload at the absolute end of your turn if actions/reads are required.`;
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				const systemPrompt = `### IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}`;

				const chatTxt = await this.runAI(body.model || "claude-3-opus-20240229", systemPrompt, userMsg, recentContext);
				await this.saveMsg(sessionId, 'assistant', chatTxt);

				if (chatTxt.includes("_ACTION_TRIGGER:")) {
					try {
						const triggerLine = chatTxt.split("\n").find(line => line.includes("_ACTION_TRIGGER:"));
						if (triggerLine) {
							const jsonString = triggerLine.substring(triggerLine.indexOf("{")).trim();
							const payload = JSON.parse(jsonString);

							const mcpResponse = await fetch("https://mcp.jolenesego.com/api/tools/execute", {
								method: "POST",
								headers: { 
									"Content-Type": "application/json",
									"User-Agent": "Cloudflare-Workers-MCP-Bridge"
								},
								body: JSON.stringify(payload)
							});

							if (!mcpResponse.ok) {
								const errText = await mcpResponse.text();
								throw new Error(`Tunnel Endpoint responded with status ${mcpResponse.status}: ${errText.substring(0, 100)}`);
							}
						}
					} catch (parseErr: any) {
						return new Response(`data: ${JSON.stringify({ response: `⚠️ MCP Pipeline Link Error: ${parseErr.message}` })}\n\ndata: [DONE]\n\n`);
					}
				}

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
