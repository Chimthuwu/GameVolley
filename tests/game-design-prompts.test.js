// Game-design prompt layer (Q10): prompt snapshot test asserting the Director,
// Developer and Critic system prompts carry the game-feel requirements
// (win/lose + restart, difficulty ramp, on-screen controls hint, juice/SFX).
const { test } = require('node:test');
const assert = require('node:assert');
const AgentManager = require('../src/main/agents/agent-manager.js');
const { GAME_GUIDELINES } = require('../src/main/agents/provider-dev-agent.js');

test('provider-dev GAME_GUIDELINES carry the game-feel requirements', () => {
  assert.match(GAME_GUIDELINES, /GAME FEEL/, 'a game-feel section exists');
  assert.match(GAME_GUIDELINES, /RESTART/i, 'restart requirement');
  assert.match(GAME_GUIDELINES, /difficulty ramp/i, 'difficulty ramp requirement');
  assert.match(GAME_GUIDELINES, /controls hint ON SCREEN/i, 'on-screen controls requirement');
  assert.match(GAME_GUIDELINES, /WebAudio/i, 'SFX via WebAudio requirement');
  assert.match(GAME_GUIDELINES, /AFTER the first user input/i, 'SFX gated on first input (autoplay policies)');
});

test('CRITIC_SYSTEM checks game feel with a calibrated severity', () => {
  assert.match(AgentManager.CRITIC_SYSTEM, /GAME-FEEL criteria/i, 'critic checks game feel');
  assert.match(AgentManager.CRITIC_SYSTEM, /RESTART/i, 'restart criterion');
  assert.match(AgentManager.CRITIC_SYSTEM, /difficulty ramp/i, 'ramp criterion');
  assert.match(AgentManager.CRITIC_SYSTEM, /MED when juice is entirely absent/, 'absent juice is MED, not HIGH');
});

test('CREATIVE_DIRECTOR_SYSTEM brief includes the must-have game-feel items', () => {
  assert.match(AgentManager.CREATIVE_DIRECTOR_SYSTEM, /win\/lose \+ restart/, 'director must-have list includes restart');
  assert.match(AgentManager.CREATIVE_DIRECTOR_SYSTEM, /on-screen controls hint/, 'director must-have list includes controls hint');
  assert.match(AgentManager.CREATIVE_DIRECTOR_SYSTEM, /difficulty ramp/, 'director must-have list includes the ramp');
  assert.match(AgentManager.CREATIVE_DIRECTOR_SYSTEM, /under 600 words/, 'brief length cap kept');
});
