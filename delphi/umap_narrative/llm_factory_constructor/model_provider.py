#!/usr/bin/env python3
"""
Model provider module for report generation.

Provides a consistent interface for different LLM backends (Ollama and Anthropic)
allowing for easy configuration and switching between model providers.
"""

import os
import hashlib
import hmac
import json
import logging
import time
import requests
from typing import Dict, List, Optional, Union, Any


def build_budget_context_header(deliberation_id, admin_user_id, secret) -> str:
    """Build the signed x-agora-budget-context header (audit F-801).

    Header format: <deliberation_id>|<admin_user_id>|<hex-hmac-sha256>
    where the HMAC input is the literal '<deliberation_id>|<admin_user_id>'
    (empty string when a field is absent; unattributed = '|'), keyed with
    the same secret as x-polis-internal-key (POLIS_INTERNAL_PROXY_SECRET).
    The header is REQUIRED even when both fields are absent.
    """
    delib = '' if deliberation_id is None else str(deliberation_id)
    admin = '' if admin_user_id is None else str(admin_user_id)
    hmac_input = f"{delib}|{admin}"
    digest = hmac.new(secret.encode('utf-8'), hmac_input.encode('utf-8'), hashlib.sha256).hexdigest()
    return f"{delib}|{admin}|{digest}"

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ModelProvider:
    """Base class for model providers."""
    
    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from the model.
        
        Args:
            system_message: System message/instructions
            user_message: User message/prompt
            
        Returns:
            Model response as string
        """
        raise NotImplementedError("Subclasses must implement get_response")
    
    def list_available_models(self) -> List[str]:
        """
        List available models from this provider.
        
        Returns:
            List of available model identifiers
        """
        raise NotImplementedError("Subclasses must implement list_available_models")

class OllamaProvider(ModelProvider):
    """Provider for Ollama models."""
    
    def __init__(self, model_name: str = "llama3", endpoint: str = "http://localhost:11434"):
        """
        Initialize the Ollama provider.
        
        Args:
            model_name: Name of the model to use
            endpoint: Ollama API endpoint
        """
        self.model_name = model_name
        self.endpoint = endpoint
        
        # Import ollama here to allow for optional dependency
        try:
            import ollama
            self.ollama = ollama
            # Configure endpoint if specified
            if endpoint != "http://localhost:11434":
                self.ollama.client.api_base = endpoint
        except ImportError:
            logger.warning("Ollama package not installed. Using direct HTTP requests instead.")
            self.ollama = None
    
    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from an Ollama model.
        
        Args:
            system_message: System message/instructions
            user_message: User message/prompt
            
        Returns:
            Model response as string
        """
        try:
            logger.info(f"Using Ollama model: {self.model_name}")
            
            if self.ollama:
                # Use the Ollama package if available
                response = self.ollama.chat(
                    model=self.model_name,
                    messages=[
                        {"role": "system", "content": system_message},
                        {"role": "user", "content": user_message}
                    ]
                )
                result = response['message']['content'].strip()
            else:
                # Use direct HTTP request as fallback
                response = requests.post(
                    f"{self.endpoint}/api/chat",
                    json={
                        "model": self.model_name,
                        "messages": [
                            {"role": "system", "content": system_message},
                            {"role": "user", "content": user_message}
                        ],
                        "stream": False
                    }
                )
                response.raise_for_status()
                result = response.json()["message"]["content"].strip()
            
            return result
        
        except Exception as e:
            logger.error(f"Error using Ollama: {str(e)}")
            # Return a JSON error response
            return json.dumps({
                "id": "polis_narrative_error_message",
                "title": "Model Error",
                "paragraphs": [
                    {
                        "id": "polis_narrative_error_message",
                        "title": "Error Processing With Model",
                        "sentences": [
                            {
                                "clauses": [
                                    {
                                        "text": f"There was an error using the Ollama model: {str(e)}",
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })
    
    def list_available_models(self) -> List[str]:
        """
        List available Ollama models.
        
        Returns:
            List of available model identifiers
        """
        try:
            if self.ollama:
                # Use the Ollama package if available
                models_response = self.ollama.list()
                # Handle new Ollama API response format which has a 'models' list of Model objects
                if hasattr(models_response, 'models') and isinstance(models_response.models, list):
                    available_models = [m.model for m in models_response.models]
                else:
                    # Fallback for older API versions or different response format
                    available_models = [model.get('name') for model in models_response.get('models', [])]
            else:
                # Use direct HTTP request as fallback
                response = requests.get(f"{self.endpoint}/api/tags")
                response.raise_for_status()
                available_models = [model.get('name') for model in response.json().get('models', [])]
            
            logger.info(f"Available Ollama models: {available_models}")
            return available_models
        
        except Exception as e:
            logger.error(f"Error listing Ollama models: {str(e)}")
            return []

class AnthropicProvider(ModelProvider):
    """Provider for Anthropic Claude models."""

    def __init__(self, model_name: str = None, api_key: Optional[str] = None):
        """
        Initialize the Anthropic provider.

        Args:
            model_name: Name of the Claude model to use
            api_key: Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
        """
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")

        if not self.api_key:
            logger.warning("No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.")

        # Force using direct HTTP requests instead of the anthropic package
        # since we're having issues with the package in the container
        logger.warning("Forcing use of direct HTTP requests for Anthropic API")
        self.anthropic = None
        self.client = None

        # Log API key presence (without revealing it)
        if self.api_key:
            logger.info(f"Anthropic API key is set (starts with: {self.api_key[:8]}...)")
        else:
            logger.warning("No Anthropic API key found in environment")
    
    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from a Claude model.
        
        Args:
            system_message: System message/instructions
            user_message: User message/prompt
            
        Returns:
            Model response as string
        """
        if not self.api_key:
            raise ValueError(
                "No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter."
            )
        
        logger.info(f"Using Anthropic model: {self.model_name}")

        if self.client:
            # Use the Anthropic package if available
            message = self.client.messages.create(
                model=self.model_name,
                system=system_message,
                messages=[{"role": "user", "content": user_message}],
                max_tokens=4000,
            )
            return message.content[0].text

        # Use direct HTTP request with retries for transient overload/rate limiting.
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        data = {
            "model": self.model_name,
            "system": system_message,
            "messages": [{"role": "user", "content": user_message}],
            "max_tokens": 4000,
        }

        retryable_statuses = {429, 500, 502, 503, 504, 529}
        last_exc: Optional[Exception] = None
        last_status: Optional[int] = None
        last_body: str = ""

        for attempt in range(5):
            try:
                response = requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers=headers,
                    json=data,
                    timeout=(10, 120),
                )

                if response.status_code in retryable_statuses:
                    last_status = response.status_code
                    last_body = (response.text or "")[:2000]

                    retry_after = response.headers.get("retry-after")
                    if retry_after and retry_after.isdigit():
                        sleep_s = float(retry_after)
                    else:
                        sleep_s = min(30.0, 1.5 * (2**attempt))

                    logger.warning(
                        "Anthropic transient HTTP %s (attempt %s/%s); retrying in %.1fs",
                        response.status_code,
                        attempt + 1,
                        5,
                        sleep_s,
                    )
                    time.sleep(sleep_s)
                    continue

                response.raise_for_status()
                payload = response.json()
                return payload["content"][0]["text"]

            except requests.exceptions.RequestException as e:
                last_exc = e
                sleep_s = min(30.0, 1.5 * (2**attempt))
                logger.warning(
                    "Anthropic request exception (attempt %s/%s): %s; retrying in %.1fs",
                    attempt + 1,
                    5,
                    str(e),
                    sleep_s,
                )
                time.sleep(sleep_s)
                continue
            except Exception as e:
                last_exc = e
                break

        detail = f"status={last_status} body={last_body}" if last_status else "no_http_status"
        if last_exc:
            raise RuntimeError(f"Anthropic API request failed after retries ({detail}): {last_exc}") from last_exc
        raise RuntimeError(f"Anthropic API request failed after retries ({detail})")
    
    def get_batch_responses(self, batch_requests: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Submit a batch of requests to the Anthropic Batch API.
        
        Args:
            batch_requests: List of request objects, each containing:
                - system: System message
                - messages: List of message objects
                - max_tokens: Maximum tokens for response
                - metadata: Dictionary with request metadata
                
        Returns:
            Dictionary with batch job metadata
        """
        if not self.api_key:
            logger.error("No Anthropic API key provided for batch requests")
            return {"error": "API key missing"}
        
        try:
            logger.info(f"Submitting batch of {len(batch_requests)} requests to Anthropic API")
            
            # Use Anthropic Batch API endpoint
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }
            
            # Format requests for Batch API
            formatted_requests = []
            for i, request in enumerate(batch_requests):
                req = {
                    "model": self.model_name,
                    "system": request.get("system", ""),
                    "messages": request.get("messages", []),
                    "max_tokens": request.get("max_tokens", 4000)
                }
                
                # Add request ID (for correlation on response)
                req["request_id"] = f"req_{i}"
                
                formatted_requests.append(req)
            
            # Check if Batch API is available
            try:
                # Make a request to the Batch API endpoint
                batch_request_data = {
                    "requests": formatted_requests
                }
                
                response = requests.post(
                    "https://api.anthropic.com/v1/messages/batch",
                    headers=headers,
                    json=batch_request_data
                )
                
                # Check if the response indicates Batch API is not available
                if response.status_code == 404:
                    logger.warning("Anthropic Batch API endpoint not found (404). Falling back to sequential processing.")
                    return {"error": "Batch API not available", "fallback": "sequential"}
                
                # Raise for other errors
                response.raise_for_status()
                
                # Get response data
                response_data = response.json()
                logger.info(f"Batch submitted successfully. Batch ID: {response_data.get('batch_id')}")
                
                # Add metadata mapping
                response_data["request_metadata"] = {f"req_{i}": request.get("metadata", {}) for i, request in enumerate(batch_requests)}
                
                return response_data
                
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 404:
                    logger.warning("Anthropic Batch API endpoint not found (404). Falling back to sequential processing.")
                    return {"error": "Batch API not available", "fallback": "sequential"}
                else:
                    logger.error(f"HTTP error using Anthropic Batch API: {str(e)}")
                    return {"error": f"HTTP error: {str(e)}"}
                    
            except Exception as e:
                logger.error(f"Error using Anthropic Batch API: {str(e)}")
                return {"error": str(e)}
                
        except Exception as e:
            logger.error(f"Error preparing batch request: {str(e)}")
            return {"error": str(e)}
    
    def list_available_models(self) -> List[str]:
        """
        List available Claude models.

        Returns:
            List of hardcoded available model identifiers
        """
        # Anthropic doesn't have a list models endpoint, so we hardcode the known models
        available_models = [
            "claude-3-5-sonnet-20241022",
            "claude-3-7-sonnet-20250219",
            "claude-opus-4-20250514"
        ]
        logger.info(f"Available Anthropic models: {available_models}")
        return available_models

    async def get_completion(self, system: str, prompt: str, max_tokens: int = 4000) -> Dict[str, Any]:
        """
        Get a completion from the Anthropic API with the new completion format.
        This method is specifically for the batch report generator.

        Args:
            system: System message/instructions
            prompt: User message/prompt
            max_tokens: Maximum tokens for response

        Returns:
            Dictionary with model response
        """
        logger.info(f"Getting completion from Anthropic API using model: {self.model_name}")

        if not self.api_key:
            logger.error("No Anthropic API key provided for completion")
            return {"content": json.dumps({
                "id": "polis_narrative_error_message",
                "title": "API Key Missing",
                "paragraphs": [
                    {
                        "id": "polis_narrative_error_message",
                        "title": "API Key Missing",
                        "sentences": [
                            {
                                "clauses": [
                                    {
                                        "text": "No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.",
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })}

        try:
            # Use direct HTTP request for completions
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }

            data = {
                "model": self.model_name,
                "system": system,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": max_tokens
            }

            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=data
            )

            # Raise for HTTP errors
            response.raise_for_status()

            # Parse response
            response_data = response.json()
            result = response_data["content"][0]["text"]

            return {"content": result}

        except Exception as e:
            logger.error(f"Error in get_completion: {str(e)}")
            return {"content": json.dumps({
                "id": "polis_narrative_error_message",
                "title": "Model Error",
                "paragraphs": [
                    {
                        "id": "polis_narrative_error_message",
                        "title": "Error Processing With Model",
                        "sentences": [
                            {
                                "clauses": [
                                    {
                                        "text": f"There was an error using the Anthropic API: {str(e)}",
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })}
class OpenAIProvider(ModelProvider):
    """Provider for OpenAI models."""

    def __init__(self, model_name: str = None, api_key: Optional[str] = None):
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        if not self.api_key:
            logger.warning("No OpenAI API key provided. Set OPENAI_API_KEY env var.")

    def get_response(self, system_message: str, user_message: str) -> str:
        if not self.api_key:
            raise ValueError("No OpenAI API key provided.")
        
        logger.info(f"Using OpenAI model: {self.model_name}")
        
        from openai import OpenAI
        client = OpenAI(api_key=self.api_key)
        
        retryable_statuses = {429, 500, 502, 503}
        last_exc = None
        
        for attempt in range(5):
            try:
                response = client.chat.completions.create(
                    model=self.model_name,
                    messages=[
                        {"role": "system", "content": system_message},
                        {"role": "user", "content": user_message}
                    ],
                    max_tokens=4000,
                )
                return response.choices[0].message.content
            except Exception as e:
                last_exc = e
                status = getattr(e, 'status_code', None) or getattr(getattr(e, 'response', None), 'status_code', None)
                if status not in retryable_statuses:
                    break
                sleep_s = min(30.0, 1.5 * (2 ** attempt))
                logger.warning(f"OpenAI transient error (attempt {attempt+1}/5); retrying in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
        
        raise RuntimeError(f"OpenAI API request failed after retries: {last_exc}")
    
    def list_available_models(self) -> List[str]:
        return ["gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5.4", "gpt-5.4-mini"]

class DeepSeekProvider(ModelProvider):
    """Provider for DeepSeek models (OpenAI-API-compatible)."""

    def __init__(self, model_name: str = None, api_key: Optional[str] = None):
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not self.api_key:
            logger.warning("No DeepSeek API key provided. Set DEEPSEEK_API_KEY env var.")

    def get_response(self, system_message: str, user_message: str) -> str:
        if not self.api_key:
            raise ValueError("No DeepSeek API key provided.")
        
        logger.info(f"Using DeepSeek model: {self.model_name}")
        
        from openai import OpenAI
        client = OpenAI(api_key=self.api_key, base_url="https://api.deepseek.com/v1")
        
        retryable_statuses = {429, 500, 502, 503}
        last_exc = None
        
        # DeepSeek may not support system role natively; prepend to user message if needed
        messages = [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message}
        ]
        
        for attempt in range(5):
            try:
                response = client.chat.completions.create(
                    model=self.model_name,
                    messages=messages,
                    max_tokens=4000,
                )
                return response.choices[0].message.content
            except Exception as e:
                last_exc = e
                status = getattr(e, 'status_code', None) or getattr(getattr(e, 'response', None), 'status_code', None)
                if status not in retryable_statuses:
                    break
                sleep_s = min(30.0, 2.0 * (2 ** attempt))  # slightly longer backoff for DeepSeek rate limits
                logger.warning(f"DeepSeek transient error (attempt {attempt+1}/5); retrying in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
        
        raise RuntimeError(f"DeepSeek API request failed after retries: {last_exc}")
    
    def list_available_models(self) -> List[str]:
        return ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash"]

class GoogleProvider(ModelProvider):
    """Provider for Google Gemini models."""

    def __init__(self, model_name: str = None, api_key: Optional[str] = None):
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("GOOGLE_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            logger.warning("No Google API key provided. Set GOOGLE_GEMINI_API_KEY env var.")

    def get_response(self, system_message: str, user_message: str) -> str:
        if not self.api_key:
            raise ValueError("No Google API key provided.")
        
        logger.info(f"Using Google model: {self.model_name}")
        
        import google.generativeai as genai
        genai.configure(api_key=self.api_key)
        
        # Gemini uses system_instruction in the model constructor
        model = genai.GenerativeModel(
            model_name=self.model_name,
            system_instruction=system_message,
        )
        
        retryable_statuses = {429, 500, 502, 503}
        last_exc = None
        
        for attempt in range(5):
            try:
                response = model.generate_content(user_message)
                return response.text
            except Exception as e:
                last_exc = e
                status = getattr(e, 'code', None) or getattr(getattr(e, 'response', None), 'status_code', None)
                if status not in retryable_statuses:
                    break
                sleep_s = min(30.0, 1.5 * (2 ** attempt))
                logger.warning(f"Google transient error (attempt {attempt+1}/5); retrying in {sleep_s:.1f}s")
                time.sleep(sleep_s)
                continue
        
        raise RuntimeError(f"Google API request failed after retries: {last_exc}")
    
    def list_available_models(self) -> List[str]:
        return ["gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash"]


class AgoraProxyProvider(ModelProvider):
    """Provider that routes LLM calls through Agora's resilience layer.
    
    Instead of calling LLM APIs directly, this provider sends requests
    to the Agora backend which handles fallback, circuit breakers,
    and unified logging.
    
    Supports full 3-tier cascade: primary → backup → fallback.
    """
    
    def __init__(self, model, provider, 
                 backup_model=None, backup_provider=None,
                 fallback_model=None, fallback_provider=None,
                 temperature=None, max_tokens=None, json_mode=False,
                 use_case='delphi_report',
                 deliberation_id=None,
                 admin_user_id=None):
        """Initialize the Agora proxy provider with full cascade config.
        
        Args:
            model: Primary model name
            provider: Primary provider name (e.g., 'anthropic', 'openai')
            backup_model: Backup model name for fallback tier 1
            backup_provider: Backup provider name for fallback tier 1
            fallback_model: Fallback model name for fallback tier 2
            fallback_provider: Fallback provider name for fallback tier 2
            temperature: LLM temperature
            max_tokens: Maximum output tokens
            json_mode: Whether to request JSON mode
            use_case: Identifier for Agora's usage logging
            deliberation_id: The Agora deliberation ID
            admin_user_id: The admin user ID for authorization
        """
        self.model = model
        self.provider = provider
        self.backup_model = backup_model
        self.backup_provider = backup_provider
        self.fallback_model = fallback_model
        self.fallback_provider = fallback_provider
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.json_mode = json_mode
        self.use_case = use_case
        self.deliberation_id = deliberation_id
        self.admin_user_id = admin_user_id
    
    def get_response(self, system_message: str, user_message: str) -> str:
        """Send messages to Agora proxy and return the content string.
        
        Converts the simple system_message/user_message format
        into OpenAI-style messages array, sends to Agora,
        and returns just the content string (maintaining compatibility
        with the existing interface).
        """
        # Build messages array from system/user format
        messages = []
        if system_message:
            messages.append({"role": "system", "content": system_message})
        messages.append({"role": "user", "content": user_message})
        
        # Resolve Agora backend URL
        agora_backend_url = os.environ.get('AGORA_BACKEND_URL') or os.environ.get('AGORA_API_URL') or 'http://agora-backend:3000'
        url = f"{agora_backend_url.rstrip('/')}/api/v1/internal/llm"
        
        # Auth headers (x-agora-budget-context is required by audit F-801;
        # signed with the same secret as x-polis-internal-key)
        internal_key = os.environ.get('POLIS_INTERNAL_PROXY_SECRET') or os.environ.get('POLIS_INTERNAL_KEY') or ''
        headers = {
            'Content-Type': 'application/json',
            'x-polis-internal-key': internal_key,
            'x-agora-budget-context': build_budget_context_header(
                self.deliberation_id, self.admin_user_id, internal_key,
            ),
        }
        
        # Build payload with all tier config
        payload = {
            "messages": messages,
            "model": self.model,
            "provider": self.provider,
            "backup_model": self.backup_model,
            "backup_provider": self.backup_provider,
            "fallback_model": self.fallback_model,
            "fallback_provider": self.fallback_provider,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "json_mode": self.json_mode,
            "use_case": self.use_case,
            "deliberation_id": self.deliberation_id,
            "admin_user_id": self.admin_user_id,
        }
        # Remove None values so Agora uses its own defaults for unset fields
        payload = {k: v for k, v in payload.items() if v is not None}
        
        logger.info(
            "AgoraProxy: sending request to %s (provider=%s, model=%s, backup=%s/%s, fallback=%s/%s)",
            url, self.provider, self.model,
            self.backup_provider, self.backup_model,
            self.fallback_provider, self.fallback_model,
        )
        
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=120)
            
            if response.status_code == 200:
                data = response.json()
                content = data.get('content', '')
                actual_model = data.get('model', 'unknown')
                actual_provider = data.get('provider', 'unknown')
                logger.info(
                    "AgoraProxy: received response from %s/%s (%d chars)",
                    actual_provider, actual_model, len(content),
                )
                return content
            else:
                error_text = response.text[:500] if response.text else 'No response body'
                logger.error(
                    "AgoraProxy: request failed with status %d: %s",
                    response.status_code, error_text,
                )
                raise RuntimeError(
                    f"Agora proxy returned status {response.status_code}: {error_text}"
                )
        except requests.exceptions.Timeout:
            logger.error("AgoraProxy: request timed out after 120s")
            raise RuntimeError("Agora proxy request timed out after 120 seconds")
        except requests.exceptions.ConnectionError as e:
            logger.error("AgoraProxy: connection error: %s", str(e))
            raise RuntimeError(f"Agora proxy connection failed: {e}")
        except requests.exceptions.RequestException as e:
            logger.error("AgoraProxy: request error: %s", str(e))
            raise RuntimeError(f"Agora proxy request failed: {e}")
    
    def list_available_models(self) -> List[str]:
        """List available models (delegated to Agora)."""
        # The proxy abstracts model selection; return the configured tiers
        models = [f"{self.provider}/{self.model}"]
        if self.backup_provider and self.backup_model:
            models.append(f"{self.backup_provider}/{self.backup_model}")
        if self.fallback_provider and self.fallback_model:
            models.append(f"{self.fallback_provider}/{self.fallback_model}")
        return models


class AgoraProxyError(RuntimeError):
    """Base class for AgoraProxyBatchClient failures.

    Subclasses RuntimeError so callers written against the plain
    'RuntimeError' contract keep working unchanged.
    """
    pass


class AgoraProxyTransportError(AgoraProxyError):
    """The Agora proxy could not be reached (timeout / connection / request error).

    Callers treat this as an infrastructure failure: fall back to the direct
    provider SDK path.
    """
    pass


class AgoraProxyStatusError(AgoraProxyError):
    """The Agora proxy responded with a non-200 HTTP status.

    Attributes:
        status_code: The HTTP status returned by the proxy. Callers use this
            to distinguish real config/budget errors (400/401/402 — do NOT
            fall back to the direct SDK) from transient server errors
            (5xx / 502 batch_submission_failed — fallback allowed).
    """

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        super().__init__(message)


class BatchNotCompleteError(RuntimeError):
    """Raised when the Agora batch proxy reports a batch is not yet complete (HTTP 409).

    Callers can catch this to distinguish 'still processing' from real failures.
    """
    pass


class AgoraProxyBatchClient:
    """Client for Agora's batch LLM proxy endpoints.

    Mirrors AgoraProxyProvider's URL/key resolution, auth headers, timeout,
    and error handling exactly so callers get the same failure semantics
    (RuntimeError on non-200 responses and transport errors; see
    AgoraProxyStatusError / AgoraProxyTransportError for finer distinctions).

    Endpoints:
        POST {base}/api/v1/internal/llm/batch                  -> submit
        GET  {base}/api/v1/internal/llm/batch/{id}/status      -> status
        GET  {base}/api/v1/internal/llm/batch/{id}/results     -> results
    """

    def __init__(self, use_case: str = 'delphi_report', deliberation_id: str = None,
                 timeout: int = 120):
        """Initialize the client.

        Args:
            use_case: Agora use-case identifier (usage logging / tier config).
            deliberation_id: Agora deliberation ID (only sent if set).
            timeout: Request timeout in seconds (matches AgoraProxyProvider).
        """
        self.use_case = use_case
        self.deliberation_id = deliberation_id
        self.timeout = timeout
        agora_backend_url = os.environ.get('AGORA_BACKEND_URL') or os.environ.get('AGORA_API_URL') or 'http://agora-backend:3000'
        self.base_url = f"{agora_backend_url.rstrip('/')}/api/v1/internal/llm/batch"
        internal_key = os.environ.get('POLIS_INTERNAL_PROXY_SECRET') or os.environ.get('POLIS_INTERNAL_KEY') or ''
        # x-agora-budget-context is required on POST /batch (audit F-801).
        # admin_user_id is not available in this client -> signed as absent.
        self.headers = {
            'Content-Type': 'application/json',
            'x-polis-internal-key': internal_key,
            'x-agora-budget-context': build_budget_context_header(
                self.deliberation_id, None, internal_key,
            ),
        }

    def _handle_response(self, response, action: str, allow_not_complete: bool = False) -> dict:
        """Parse a proxy response, raising on non-200 (or BatchNotCompleteError for 409)."""
        if response.status_code == 200:
            return response.json()
        error_text = response.text[:500] if response.text else 'No response body'
        if response.status_code == 409 and allow_not_complete:
            raise BatchNotCompleteError(
                f"Agora batch not complete (status 409): {error_text}"
            )
        logger.error(
            "AgoraProxyBatch: %s failed with status %d: %s",
            action, response.status_code, error_text,
        )
        raise AgoraProxyStatusError(
            response.status_code,
            f"Agora proxy returned status {response.status_code}: {error_text}",
        )

    def _request(self, method: str, url: str, action: str, allow_not_complete: bool = False, **kwargs) -> dict:
        """Run a request with AgoraProxyProvider-compatible error handling."""
        try:
            response = requests.request(method, url, headers=self.headers, timeout=self.timeout, **kwargs)
            return self._handle_response(response, action, allow_not_complete=allow_not_complete)
        except BatchNotCompleteError:
            raise
        except requests.exceptions.Timeout:
            logger.error("AgoraProxyBatch: %s timed out after %ds", action, self.timeout)
            raise AgoraProxyTransportError(f"Agora proxy {action} timed out after {self.timeout} seconds")
        except requests.exceptions.ConnectionError as e:
            logger.error("AgoraProxyBatch: %s connection error: %s", action, str(e))
            raise AgoraProxyTransportError(f"Agora proxy {action} connection failed: {e}")
        except requests.exceptions.RequestException as e:
            logger.error("AgoraProxyBatch: %s request error: %s", action, str(e))
            raise AgoraProxyTransportError(f"Agora proxy {action} request failed: {e}")

    def submit_batch(self, prompts: list) -> dict:
        """Submit a batch of prompts to the Agora proxy.

        Args:
            prompts: List of prompt dicts, each with 'custom_id' plus optional
                'system', 'messages' (list of {role, content}), 'max_tokens',
                and 'temperature'. Agora resolves provider/model tiers itself
                from agora_ai_use_case_config (self.use_case) — Delphi does
                not send model/provider.

        Returns:
            Parsed JSON response dict with batch_id, provider, model,
            mode ('native_batch'|'sequential'), prompt_count, etc.

        Raises:
            RuntimeError: On any non-200 response or transport error.
        """
        payload = {'use_case': self.use_case, 'prompts': prompts}
        if self.deliberation_id:
            payload['deliberation_id'] = self.deliberation_id
        logger.info(
            "AgoraProxyBatch: submitting %d prompts to %s (use_case=%s)",
            len(prompts), self.base_url, self.use_case,
        )
        return self._request('POST', self.base_url, 'batch submission', json=payload)

    def get_batch_status(self, batch_id: str) -> dict:
        """Check the status of an Agora-proxied batch.

        Returns:
            Parsed JSON response dict with 'status' in
            (pending, processing, completed, failed, expired).

        Raises:
            RuntimeError: On any non-200 response or transport error.
        """
        url = f"{self.base_url}/{batch_id}/status"
        logger.info("AgoraProxyBatch: checking status for batch %s", batch_id)
        return self._request('GET', url, 'batch status check')

    def get_batch_results(self, batch_id: str) -> dict:
        """Fetch results for a completed Agora-proxied batch.

        Returns the full response dict:
            {batch_id, status, results: [{custom_id, content, model, provider,
            input_tokens, output_tokens, finish_reason}],
            failures: [{custom_id, error}]}

        Raises:
            BatchNotCompleteError: If the proxy returns 409 (batch not complete).
            RuntimeError: On any other non-200 response or transport error
                (AgoraProxyStatusError / AgoraProxyTransportError subclasses).
        """
        url = f"{self.base_url}/{batch_id}/results"
        logger.info("AgoraProxyBatch: fetching results for batch %s", batch_id)
        data = self._request('GET', url, 'batch results fetch', allow_not_complete=True)
        if not isinstance(data, dict) or not isinstance(data.get('results'), list):
            logger.error(
                "AgoraProxyBatch: unexpected results payload shape: %s", str(data)[:500],
            )
            raise RuntimeError(f"Agora proxy returned unexpected results payload: {str(data)[:500]}")
        return data


def agora_batch_available() -> bool:
    """Return True when the Agora batch proxy should be used for batch submissions.

    Uses the same check the narrative report batch generator already relies on
    (LLM_PROVIDER == 'agora' or AGORA_BACKEND_URL set).
    """
    return (
        os.environ.get('LLM_PROVIDER') == 'agora'
        or bool(os.environ.get('AGORA_BACKEND_URL'))
    )


def agora_batch_configured() -> bool:
    """Return True when the Agora batch proxy is fully configured (URL + secret).

    Unlike agora_batch_available(), this requires BOTH the backend URL and the
    internal auth key to be present — used as the proxy-first gate so callers
    can fall back to the direct SDK cleanly when the proxy is not configured.
    """
    url = os.environ.get('AGORA_BACKEND_URL') or os.environ.get('AGORA_API_URL')
    if not url:
        return False
    key = os.environ.get('POLIS_INTERNAL_PROXY_SECRET') or os.environ.get('POLIS_INTERNAL_KEY')
    return bool(key)


def log_ai_usage(
    use_case: str,
    model: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    deliberation_id: str = None,
    origin: str = 'polis',
):
    """Log AI usage to Agora's internal usage endpoint.
    
    Args:
        use_case: The use case identifier (e.g., 'delphi_report')
        model: The model name used
        provider: The provider name
        input_tokens: Number of input/prompt tokens
        output_tokens: Number of output/completion tokens
        deliberation_id: The Agora deliberation ID
        origin: Origin system ('polis' or 'agora')
    """
    import requests as req
    
    agora_backend_url = os.environ.get('AGORA_BACKEND_URL') or os.environ.get('AGORA_API_URL') or 'http://agora-backend:3000'
    internal_key = os.environ.get('POLIS_INTERNAL_PROXY_SECRET') or os.environ.get('POLIS_INTERNAL_KEY') or ''
    
    url = f"{agora_backend_url.rstrip('/')}/api/v1/internal/ai-usage"
    headers = {
        'Content-Type': 'application/json',
        'x-polis-internal-key': internal_key,
    }
    payload = {
        'use_case': use_case,
        'model': model,
        'provider': provider,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'deliberation_id': deliberation_id or '',
        'origin': origin,
    }
    
    try:
        resp = req.post(url, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"Logged AI usage: {provider}/{model}, {input_tokens}+{output_tokens} tokens")
        else:
            logger.warning(f"Failed to log AI usage (status {resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        logger.warning(f"Failed to log AI usage (connection error): {e}")

def get_model_provider_with_cascade(report_stage_config: dict) -> ModelProvider:
    """Resolve a model provider that delegates cascade to Agora's resilience layer.
    
    Instead of trying each tier locally, this creates a single AgoraProxyProvider
    with all tiers configured so that Agora's callAIProvider handles the cascade
    with circuit breakers, fallback, and unified logging.
    
    Args:
        report_stage_config: Dict with keys 'provider', 'model', 
            'backup_provider', 'backup_model', 'fallback_provider', 'fallback_model'
    
    Returns:
        An AgoraProxyProvider instance with all tiers configured
    
    Raises:
        ValueError: If no primary provider/model is configured
    """
    primary_provider = report_stage_config.get('provider') or os.environ.get('NARRATIVE_BATCH_PROVIDER')
    primary_model = report_stage_config.get('model') or os.environ.get('ANTHROPIC_MODEL')
    
    if not primary_provider or not primary_model:
        raise ValueError(
            "Primary provider and model must be configured. "
            "Set 'provider'/'model' in config or NARRATIVE_BATCH_PROVIDER/ANTHROPIC_MODEL env vars."
        )
    
    logger.info(
        "Cascade: delegating to AgoraProxy (primary=%s/%s, backup=%s/%s, fallback=%s/%s)",
        primary_provider, primary_model,
        report_stage_config.get('backup_provider'), report_stage_config.get('backup_model'),
        report_stage_config.get('fallback_provider'), report_stage_config.get('fallback_model'),
    )
    
    return AgoraProxyProvider(
        model=primary_model,
        provider=primary_provider,
        backup_model=report_stage_config.get('backup_model'),
        backup_provider=report_stage_config.get('backup_provider'),
        fallback_model=report_stage_config.get('fallback_model'),
        fallback_provider=report_stage_config.get('fallback_provider'),
    )


def get_model_provider(provider_type: str = None, model_name: str = None) -> ModelProvider:
    """
    Factory function to get the appropriate model provider.
    
    Args:
        provider_type: Type of provider ('ollama', 'anthropic')
        model_name: Name of the model to use
        
    Returns:
        Configured ModelProvider instance
    """
    # Check for environment variable configuration
    provider_type = provider_type or os.environ.get("LLM_PROVIDER")
    
    if provider_type and provider_type.lower() == "anthropic":
        model_name = model_name or os.environ.get("ANTHROPIC_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or ANTHROPIC_MODEL env var must be set")
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        logger.info(f"Using Anthropic provider with model: {model_name}")
        return AnthropicProvider(model_name=model_name, api_key=api_key)
    elif provider_type and provider_type.lower() == "openai":
        model_name = model_name or os.environ.get("OPENAI_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or OPENAI_MODEL env var must be set")
        api_key = os.environ.get("OPENAI_API_KEY")
        logger.info(f"Using OpenAI provider with model: {model_name}")
        return OpenAIProvider(model_name=model_name, api_key=api_key)
    elif provider_type and provider_type.lower() == "deepseek":
        model_name = model_name or os.environ.get("DEEPSEEK_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or DEEPSEEK_MODEL env var must be set")
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        logger.info(f"Using DeepSeek provider with model: {model_name}")
        return DeepSeekProvider(model_name=model_name, api_key=api_key)
    elif provider_type and provider_type.lower() in ("google", "gemini"):
        model_name = model_name or os.environ.get("GOOGLE_MODEL") or os.environ.get("GEMINI_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or GOOGLE_MODEL env var must be set")
        api_key = os.environ.get("GOOGLE_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
        logger.info(f"Using Google provider with model: {model_name}")
        return GoogleProvider(model_name=model_name, api_key=api_key)
    elif provider_type and provider_type.lower() == "agora":
        model_name = model_name or os.environ.get("ANTHROPIC_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or ANTHROPIC_MODEL env var must be set")
        # Agora provider type uses the proxy — delegate all LLM calls through Agora
        provider = provider_type.lower()
        logger.info(f"Using AgoraProxy provider with model: {model_name} (provider={provider})")
        return AgoraProxyProvider(model=model_name, provider=provider)
    else:
        # Default to Ollama
        model_name = model_name or os.environ.get("OLLAMA_MODEL", "llama3")
        endpoint = os.environ.get("OLLAMA_ENDPOINT", "http://localhost:11434")
        logger.info(f"Using Ollama provider with model: {model_name} at {endpoint}")
        return OllamaProvider(model_name=model_name, endpoint=endpoint)

if __name__ == "__main__":
    # Simple test function
    provider = get_model_provider()
    models = provider.list_available_models()
    print(f"Available models: {models}")
    
    response = provider.get_response(
        system_message="You are a helpful assistant.",
        user_message="What is the meaning of life?"
    )
    print(f"Response: {response}")