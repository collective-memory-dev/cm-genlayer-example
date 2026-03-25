# v0.1.2
# { "Depends": "py-genlayer:latest" }
from genlayer import *
import json

class StakeBot(gl.Contract):
    # on-chain storage for last review
    last_decision: str
    last_explanation: str

    def __init__(self):
        # no deployment parameters
        self.last_decision = ""
        self.last_explanation = ""

    @gl.public.write
    def review_image(self, description: str) -> None:
        prompt = f"""
You are assigned the task of deciding which action to recommend based on content.
Your available actions are exactly:
  • stake
  • do not stake

Image description:
\"{description}\"

If the image is visually interesting, beautiful person taking a selfie, provocative, newsworthy, or depicts an unusual or dramatic scene, choose “stake”.
Otherwise choose “do not stake”.

You must respond with a JSON object with two fields:
{{
  "decision": "stake" or "do not stake",
  "explanation": "A brief short rationale for your choice, only a sentence addressed to the creator."
}}
"""

        def normalize_decision(value: str) -> str:
            text = value.strip().lower()
            if text == "stake":
                return "stake"
            if text in ("do not stake", "do_not_stake", "dont stake", "don't stake", "no stake", "not stake"):
                return "do not stake"
            if "do not stake" in text or "don't stake" in text:
                return "do not stake"
            if "stake" in text:
                return "stake"
            return "do not stake"

        def parse_result_payload(payload) -> dict:
            if isinstance(payload, dict):
                return payload
            if not isinstance(payload, str):
                return {}
            cleaned = payload.replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(cleaned)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                pass
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start >= 0 and end > start:
                candidate = cleaned[start:end + 1]
                try:
                    parsed = json.loads(candidate)
                    return parsed if isinstance(parsed, dict) else {}
                except Exception:
                    return {}
            return {}

        def ask_llm() -> str:
            raw = gl.nondet.exec_prompt(prompt)
            if isinstance(raw, dict):
                return json.dumps(raw)
            if isinstance(raw, str):
                return raw.replace("```json", "").replace("```", "").strip()
            return json.dumps({
                "decision": "do not stake",
                "explanation": "Model returned unsupported output type."
            })

        result = gl.eq_principle.prompt_comparative(
            ask_llm,
            "The value of decision has to match"
        )

        parsed = parse_result_payload(result)
        decision = normalize_decision(str(parsed.get("decision", "")))
        explanation = parsed.get("explanation")
        if not isinstance(explanation, str) or not explanation.strip():
            explanation = "Could not produce a reliable explanation."

        self.last_decision = decision
        self.last_explanation = explanation

    @gl.public.view
    def get_last_review(self) -> dict:
        """
        VIEW call:
        - Returns the most recent { 'decision': str, 'explanation': str }
        """
        return {
            "decision":    self.last_decision,
            "explanation": self.last_explanation
        }