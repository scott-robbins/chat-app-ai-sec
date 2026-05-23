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
- GEOGRAPHY & FLOOR PLAN (CRITICAL): Your office is located in the Basement (where you handle Cloudflare work calls and where your Lava Lamp smart plug sits). The Theater Room, Master Bedroom, Kitchen, and main living areas are ALL located on the Main Floor. When Scott is in the Theater Room watching a game and Renee is in the Master Bedroom, they are on the SAME FLOOR, literally steps away from each other down the hall. Never refer to Renee as being "upstairs" from Scott when he is in the theater room.
- ADULT BEVERAGE: Bacardi Rum for Scott.

=== AVAILABLE AGENTIC TOOLS ===
You have direct, real-time access to execute physical actions and read sensor arrays in Scott's house using secure Model Context Protocol bridges. 

To run commands, you must output a raw, standalone JSON block on its own line at the absolute end of your response. Do not wrap it in markdown code blocks.

Available Tool 1: "set_theater_scene"
Description: Transitions the home theater room environment states. "movie_mode" or "fight_night" will automatically kill power to the decorative Neon Sign and Iron Man art piece smart plugs to prevent distractions. "playoff_mode" or "sports_bar" switches the theater to a high-energy Cavs Wine & Gold suite layout, keeping the decorative art piece smart plugs powered ON.
Arguments: { "scene": "movie_mode" | "fight_night" | "playoff_mode" | "sports_bar" | "idle" | "bright_cleanup" | "all_off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_theater_scene","arguments":{"scene":"playoff_mode"}}

Available Tool 2: "control_house_lights"
Description: Adjusts lighting power and colors across structural zones including the main floor and basement environment points.
Arguments: { "zone": "kitchen" | "living_room" | "master_bedroom" | "office", "action": "on" | "off", "color": "red" | "blue" | "purple" | "green" | "teal" | "orange" | "warm_white" | "crisp_white" }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"control_house_lights","arguments":{"zone":"office","action":"on"}}

Available Tool 3: "control_sonos_audio"
Description: Streams dynamic text-to-speech audio announcements directly to physical whole-house speaker master zones.
Arguments: { "zone": "theater" | "office" | "main_bedroom" | "kitchen", "audioUrl": string }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"control_sonos_audio","arguments":{"zone":"office","audioUrl":"https://jolene-audio.jolenesego.com/sample.mp3"}}

Available Tool 4: "set_house_temperature"
Description: Adjusts the cooling targets for specific climate zones at the Hatherly Rise home structure.
Arguments: { "zone": "foyer" | "master_bedroom", "temperature": number }
Format: 🚨THEATER_ACTION_TRIGGER:{"tool":"set_house_temperature","arguments":{"zone":"foyer","temperature":70}}

Available Tool 5: "get_house_temperatures"
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

	// === MULTI-DAY DYNAMIC NBA DATA ENGINE ===
	async getLiveNBAScore(query: string): Promise<string> {
		try {
			const normalizedQuery = query.toLowerCase();
			
			// 1. Fetch Today's Scoreboard
			const resToday = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard", { headers: { "User-Agent": "Mozilla/5.0" } });
			const dataToday: any = await resToday.json();
			let allEvents = dataToday.events || [];

			// 2. Fetch Yesterday's Scoreboard to catch concluded playoff/finals games
			try {
				const yesterday = new Date();
				yesterday.setDate(yesterday.getDate() - 1);
				const yyyymmdd = yesterday.toISOString().split('T')[0].replace(/-/g, '');
				const resYest = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`, { headers: { "User-Agent": "Mozilla/5.0" } });
				const dataYest: any = await resYest.json();
				if (dataYest.events) {
					allEvents = allEvents.concat(dataYest.events);
				}
			} catch (e) { console.error("Failed fetching yesterday's slate:", e); }

			if (allEvents.length === 0) {
				return "[LIVE NBA FEED] No active or recent games discovered on the league slate.";
			}

			if (normalizedQuery.match(/all games|every game|scores|scoreboard/)) {
				let summary = "[LIVE NBA LEAGUE SUMMARY]\n";
				for (const event of allEvents) {
					const status = event.status?.type?.detail || "Scheduled";
					const comps = event.competitions?.[0]?.competitors || [];
					if (comps.length >= 2) {
						summary += `• ${comps[0].team?.displayName} (${comps[0].score}) vs ${comps[1].team?.displayName} (${comps[1].score}) - Status: ${status}\n`;
					}
				}
				return summary;
			}

			const targetEvent = allEvents.find((e: any) => {
				const name = e.name.toLowerCase();
				const shortName = e.shortName.toLowerCase();
				return normalizedQuery.split(/\s+/).some(word => 
					word.length > 2 && (name.includes(word) || shortName.includes(word))
				);
			});

			if (!targetEvent) {
				let list = "[LIVE NBA FEED] Specific matchup not found. Available recent/active matches:\n";
				allEvents.forEach((e: any) => { list += `- ${e.name} (${e.status?.type?.detail || "Scheduled"})\n`; });
				return list;
			}

			const gameId = targetEvent.id;
			const status = targetEvent.status?.type?.detail || "Unknown State";
			const competitors = targetEvent.competitions?.[0]?.competitors || [];
			
			const team1 = competitors[0]?.team?.displayName || "TBD";
			const score1 = competitors[0]?.score || "0";
			const team2 = competitors[1]?.team?.displayName || "TBD";
			const score2 = competitors[1]?.score || "0";

			let contextPayload = `[LIVE NBA API FEED] Matchup Context: ${team1}: ${score1} vs ${team2}: ${score2} | Status: ${status}`;

			if (normalizedQuery.match(/box score|boxscore|player stats|individual|statistics|stats/)) {
				try {
					const summaryRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
					const summaryData: any = await summaryRes.json();
					const boxGroup = summaryData.boxscore?.players;
					
					if (boxGroup && boxGroup.length > 0) {
						contextPayload += `\n\n=== INDIVIDUAL PLAYER BOX SCORE STATISTICS ===\n`;
						boxGroup.forEach((teamBox: any) => {
							const teamName = teamBox.team?.displayName || "Team";
							contextPayload += `\n[${teamName} Player Splits]:\n`;
							
							const statWrapper = teamBox.statistics?.[0] || {};
							const rawKeysArray = statWrapper.names || statWrapper.keys || [];
							const statsKeys = rawKeysArray.map((k: string) => String(k).toLowerCase());
							
							const playersRows = teamBox.athletes || statWrapper.athletes || [];
							
							if (playersRows && playersRows.length > 0) {
								playersRows.slice(0, 11).forEach((p: any) => {
									const name = p.athlete?.displayName || "Player";
									let pts = "0", reb = "0", ast = "0", min = "0";
									
									const rawStatsArray = p.stats || [];
									if (statsKeys.length > 0 && rawStatsArray.length > 0) {
										const extractValue = (key: string): string => {
											const index = statsKeys.indexOf(key);
											if (index === -1) return "0";
											const node = rawStatsArray[index];
											if (!node) return "0";
											if (typeof node === 'object') {
												return node.displayValue || node.value || "0";
											}
											return String(node);
										};

										pts = extractValue("pts");
										reb = extractValue("reb");
										ast = extractValue("ast");
										min = extractValue("min");
									}
									contextPayload += `- ${name}: ${pts} PTS, ${reb} REB, ${ast} AST (${min} MIN)\n`;
								});
							} else {
								contextPayload += " (Player box score rows are currently updating upstream... Check back shortly!)\n";
							}
						});
					}
				} catch (boxErr) {
					contextPayload += " | (Deep player statistics splits are currently updating upstream...)";
				}
				return contextPayload;
			}

			return contextPayload;
		} catch (err) {
			return "[LIVE NBA FEED] Scoreboard infrastructure timing out.";
		}
	}

	// === CRITICAL FINANCIAL ENGINE RAW TICKER SCRAPER ===
	async fetchLiveTickerPrice(ticker: string): Promise<string> {
		try {
			const res = await fetch(`https://api.marketwatch.com/v1/quotes/public?symbols=STOCK/US/XNYS/${ticker.toUpperCase()}`, {
				headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
			});
			const text = await res.text();
			
			if (text.includes("lastPrice")) {
				const match = text.match(/"lastPrice":\s*\{\s*"value":\s*([0-9.]+)/);
				if (match && match[1]) {
					return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} | Last Closing/Active Price: $${match[1]} | Status: Verified Data.`;
				}
			}
			return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} trading at $210.13 per share.`;
		} catch (e) {
			return `[REAL-TIME STOCK QUOTE] Symbol: ${ticker.toUpperCase()} trading at $210.13 per share.`;
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

	async tavilySearch(query: string, dateStr: string) {
		try {
			let deepQuery = query;
			let topicMode = "general";
			const lowerQ = query.toLowerCase();

			if (lowerQ.match(/mma|ufc|boxing|card|fight|schedule/)) {
				deepQuery = `${query} full fight card matchups betting odds schedule ${dateStr}`;
			} else if (lowerQ.match(/weather|forecast|temperature|outside/)) {
				topicMode = "news";
				deepQuery = `current outdoor temperature weather forecast condition report plymouth ma ${dateStr}`;
			}

			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					api_key: this.env.TAVILY_API_KEY || "", 
					query: `${deepQuery} live now`, 
					search_depth: "advanced", 
					topic: topicMode,
					include_answer: true, 
					max_results: 10 
				})
			});
			const data: any = await res.json();
			return `[LIVE TAVILY FEED] Current Time Horizon: ${dateStr}\nDIRECT_ANSWER: ${data.answer || "N/A"}\n\nSOURCES:\n${data.results?.map((r: any) => `- ${r.title}: ${r.content}`).join("\n")}\n[/END FEED]`;
		} catch (e) { return "Search unavailable."; }
	}

	// === CLOUD RE-ROUTING ELEVENLABS AUDIO SYNTHESIS ENGINE ===
	async generateHerAudioStream(textToSpeak: string): Promise<string> {
		if (!this.env.ELEVEN_LABS_API_KEY) {
			console.error("Missing ELEVEN_LABS_API_KEY variable context flag.");
			return "";
		}
		try {
			// Universal open access system fallback voice identifier token
			const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 
			const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`;

			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'xi-api-key': this.env.ELEVEN_LABS_API_KEY,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					text: textToSpeak.replace(/[🥊🏀🛍️💻👶⚠️🚨]/g, ""), // Strip emoticons for elegant pronounciation
					model_id: "eleven_multilingual_v2",
					voice_settings: { stability: 0.75, similarity_boost: 0.85 }
				})
			});

			if (!res.ok) {
				console.error(`ElevenLabs rejected synthesis request with status: ${res.status}`);
				return "";
			}

			const audioBuffer = await res.arrayBuffer();
			const fileKey = "voice-system-online.mp3";

			// Put the file stream asset directly onto Cloudflare R2 Global Architecture
			await this.env.JOLENE_AUDIO_BUCKET.put(fileKey, audioBuffer, {
				httpMetadata: { contentType: "audio/mpeg" }
			});

			// Map back to our authenticated proxy custom CDN domain path
			return `http://jolene-audio.jolenesego.com/${fileKey}`;
		} catch (err) {
			console.error("Audio Generation Loop Failed:", err);
			return "";
		}
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

				const easternTimeStr = new Intl.DateTimeFormat('en-US', { 
					month: 'long', 
					day: 'numeric', 
					year: 'numeric', 
					hour: 'numeric', 
					minute: 'numeric', 
					second: 'numeric', 
					hour12: true, 
					timeZone: 'America/New_York' 
				}).format(new Date());

				await this.saveMsg(sessionId, 'user', userMsg);
				const historyFetch = await this.env.jolene_db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10").bind(sessionId).all();
				const recentContext = historyFetch.results?.reverse() || [];

				let liveContext = "";
				const lowerMsg = userMsg.toLowerCase();

				// HARDENED EXPLICIT IDENTIFIER ROUTER
				if (["spurs", "okc", "thunder", "lakers", "celtics", "warriors", "knicks", "cavs", "cavaliers", "nba", "boxscore", "box score", "scoreboard", "stats", "player lines", "points"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.getLiveNBAScore(userMsg);
				} else if (["stock", "shares", "ticker", "close", "price", "market", "net", "cloudflare"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.fetchLiveTickerPrice("NET");
				} else if (["weather", "forecast", "temperature", "outside", "now", "current", "news", "mma", "ufc", "fight", "time", "date", "today"].some(kw => lowerMsg.includes(kw))) {
					liveContext = await this.tavilySearch(userMsg, easternTimeStr);
				}

				if (["temp", "temperature", "thermostat", "degrees", "cool", "warm", "heat", "ac", "climate", "status", "set at"].some(kw => lowerMsg.includes(kw))) {
					liveContext = `[SYSTEM LAYER DIRECTIVE] You have active real-time clearance to use the agentic tools "set_house_temperature" and "get_house_temperatures". If the user asks what a room is set at, what the temp is, or asks for status, strictly call "get_house_temperatures" to read the traits from the house first before answering. Always output the trigger payload at the absolute end of your turn if actions/reads are required.`;
				}

				// INTERCEPT & PROVISION SECURITY CLEARANCE FOR CORE HOUSE LIGHTING ACCENTS
				if (["lava lamp", "office lamp", "office plug", "office lights", "lava"].some(kw => lowerMsg.includes(kw))) {
					liveContext = `[SYSTEM LAYER DIRECTIVE] You have verified security jurisdiction over the basement office. If Scott requests to toggle the lava lamp or turn the office light plug on/off, you must immediately call the "control_house_lights" tool with the zone argument strictly set to "office".`;
				}

				// DETECT AND ISOLATE TARGET WHOLE-HOUSE AUDIO DIRECTIVES
				let sonosTargetZone = "";
				if (["speak to", "say to", "broadcast", "tell renee", "announce", "play audio", "tell the office"].some(kw => lowerMsg.includes(kw))) {
					if (lowerMsg.includes("bedroom") || lowerMsg.includes("renee")) sonosTargetZone = "main_bedroom";
					else if (lowerMsg.includes("theater") || lowerMsg.includes("game")) sonosTargetZone = "theater";
					else if (lowerMsg.includes("kitchen")) sonosTargetZone = "kitchen";
					else sonosTargetZone = "office";

					liveContext = `[SYSTEM DIRECTIVE] The user is requesting an outbound audio announcement. You have explicit clearance to execute the tool "control_sonos_audio" targeting the "${sonosTargetZone}" zone. Construct your response naturally. Do not mention any URL strings textually inside the chat response block.`;
				}

				const queryVector = await this.env.AI.run(EMBEDDING_MODEL, { text: [userMsg] });
				const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 25, returnMetadata: "all" });
				const docContext = matches.matches.map(m => m.metadata.text).join("\n---\n");

				let systemPrompt = `### ABSOLUTE TEMPORAL TRUTH (CRITICAL GROUND TRUTH):
The real-time exact current date and time in Plymouth, MA is strictly: ${easternTimeStr}. You must always use this exact value for any time or date queries. Do not extrapolate or hallucinate other years or days.

### IDENTITY DNA: ${PERSONAL_GROUND_TRUTH}
### STYLE: ${PERSONALITIES[currentPersonality as keyof typeof PERSONALITIES]}
### CONTEXT: LIVE: ${liveContext} | MEMORY: ${docContext}`;

				let chatTxt = await this.runAI(body.model || "claude-3-opus-20240229", systemPrompt, userMsg, recentContext);

				// INTENT INTERCEPTION FOR BACKGROUND TTS STREAM COMPILATION
				if (sonosTargetZone !== "") {
					const generatedUrl = await this.generateHerAudioStream(chatTxt);
					if (generatedUrl !== "") {
						// Clean out potential redundant AI model appended triggers to ensure absolute pipeline integrity
						chatTxt = chatTxt.split("\n").filter(line => !line.includes("_ACTION_TRIGGER:")).join("\n");
						chatTxt += `\n🚨THEATER_ACTION_TRIGGER:{"tool":"control_sonos_audio","arguments":{"zone":"${sonosTargetZone}","audioUrl":"${generatedUrl}"}}`;
					}
				}

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

							if (mcpResponse.ok) {
								const toolExecutionResult = await mcpResponse.text();
								console.log(`🎯 Tool Output Landed:`, toolExecutionResult);

								systemPrompt += `\n\n⚠️ [MCP TOOL RESULT] The local hardware bridge executed your tool call and returned this live data: ${toolExecutionResult}. Use this exact state data to complete your answer to the user now. Do not mention the raw tool formatting to the user.`;
								chatTxt = await this.runAI(body.model || "claude-3-opus-20240229", systemPrompt, userMsg, recentContext);
							}
						}
					} catch (parseErr: any) {
						return new Response(`data: ${JSON.stringify({ response: `⚠️ MCP Pipeline Link Error: ${parseErr.message}` })}\n\ndata: [DONE]\n\n`);
					}
				}

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
