//! `discover_tools` — meta-tool for lazy tool injection.
//!
//! Returns matching tool schemas so the LLM can discover and use tools
//! that aren't in the default "core" set.  The agent runner adds
//! discovered schemas to subsequent API calls automatically.

use {
    anyhow::Result,
    async_trait::async_trait,
    moltis_agents::tool_registry::{AgentTool, ToolRegistry},
    serde::Deserialize,
    std::sync::Arc,
    tokio::sync::RwLock,
    tracing::debug,
};

#[derive(Debug, Deserialize)]
struct Params {
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    10
}

/// Tool that searches all available tool schemas by keyword.
///
/// Holds a reference to the live tool registry so it always
/// reflects the current set of tools (including MCP tools
/// that may be loaded after startup or toggled per-session).
pub struct DiscoverToolsTool {
    registry: Arc<RwLock<ToolRegistry>>,
}

impl DiscoverToolsTool {
    pub fn new(registry: Arc<RwLock<ToolRegistry>>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl AgentTool for DiscoverToolsTool {
    fn name(&self) -> &str {
        "discover_tools"
    }

    fn description(&self) -> &str {
        "Search for available tools by keyword. Returns matching tool schemas \
         that become available for use in subsequent turns. Use this when you \
         need a capability not in your current toolset — e.g. 'neo4j', \
         'browser', 'calendar', or 'map'."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keywords to search tool names and descriptions"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of tools to return (default: 10)",
                    "default": 10
                }
            },
            "required": ["query"]
        })
    }

    async fn execute(&self, params: serde_json::Value) -> Result<serde_json::Value> {
        let params: Params = serde_json::from_value(params)?;
        let query_lower = params.query.to_lowercase();
        let keywords: Vec<&str> = query_lower.split_whitespace().collect();

        let all_schemas = self.registry.read().await.list_schemas();
        let mut scored: Vec<(usize, &serde_json::Value)> = all_schemas
            .iter()
            .filter_map(|schema| {
                let name = schema.get("name")?.as_str()?.to_lowercase();
                let desc = schema
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let haystack = format!("{name} {desc}");

                // Score: count how many query keywords match.
                let hits = keywords
                    .iter()
                    .filter(|kw| haystack.contains(**kw))
                    .count();

                if hits > 0 {
                    Some((hits, schema))
                } else {
                    None
                }
            })
            .collect();

        // Sort by relevance (more keyword hits first), stable for equal scores.
        scored.sort_by(|a, b| b.0.cmp(&a.0));

        let results: Vec<&serde_json::Value> = scored
            .into_iter()
            .take(params.limit)
            .map(|(_, schema)| schema)
            .collect();

        debug!(
            query = %params.query,
            matches = results.len(),
            total = all_schemas.len(),
            "discover_tools search"
        );

        Ok(serde_json::json!({
            "tools": results,
            "total_available": all_schemas.len(),
            "message": format!(
                "Found {} tool(s) matching '{}'. These tools are now available for use.",
                results.len(),
                params.query
            )
        }))
    }
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
#[cfg(test)]
mod tests {
    use super::*;

    fn make_tool(schemas: Vec<serde_json::Value>) -> DiscoverToolsTool {
        // Build a real registry with dummy tools that produce the desired schemas
        let registry = Arc::new(RwLock::new(ToolRegistry::default()));
        // We can't easily register dummy AgentTools, so test via the schema vec directly.
        // Instead, use a wrapper that pre-populates list_schemas.
        // For now, test the scoring logic separately.
        drop(schemas);
        drop(registry);
        unimplemented!("tests need refactoring for live registry")
    }

    // Scoring logic tests — these test the core matching without needing a registry
    #[test]
    fn keyword_scoring() {
        let schemas = vec![
            serde_json::json!({"name": "exec", "description": "Execute a shell command"}),
            serde_json::json!({"name": "mcp__neo4j__read_cypher", "description": "Run a Cypher query against the Neo4j database"}),
            serde_json::json!({"name": "web_search", "description": "Search the web"}),
        ];

        let query = "neo4j";
        let query_lower = query.to_lowercase();
        let keywords: Vec<&str> = query_lower.split_whitespace().collect();

        let scored: Vec<(usize, &serde_json::Value)> = schemas
            .iter()
            .filter_map(|schema| {
                let name = schema.get("name")?.as_str()?.to_lowercase();
                let desc = schema.get("description").and_then(|d| d.as_str()).unwrap_or("").to_lowercase();
                let haystack = format!("{name} {desc}");
                let hits = keywords.iter().filter(|kw| haystack.contains(**kw)).count();
                if hits > 0 { Some((hits, schema)) } else { None }
            })
            .collect();

        assert_eq!(scored.len(), 1);
        assert_eq!(scored[0].1["name"], "mcp__neo4j__read_cypher");
    }

    #[test]
    fn multi_keyword_ranks_higher() {
        let schemas = vec![
            serde_json::json!({"name": "browser", "description": "Open a URL in a headless browser and return content"}),
            serde_json::json!({"name": "web_search", "description": "Search the web using Brave or Perplexity"}),
        ];

        let query = "search web";
        let query_lower = query.to_lowercase();
        let keywords: Vec<&str> = query_lower.split_whitespace().collect();

        let mut scored: Vec<(usize, &serde_json::Value)> = schemas
            .iter()
            .filter_map(|schema| {
                let name = schema.get("name")?.as_str()?.to_lowercase();
                let desc = schema.get("description").and_then(|d| d.as_str()).unwrap_or("").to_lowercase();
                let haystack = format!("{name} {desc}");
                let hits = keywords.iter().filter(|kw| haystack.contains(**kw)).count();
                if hits > 0 { Some((hits, schema)) } else { None }
            })
            .collect();

        scored.sort_by(|a, b| b.0.cmp(&a.0));
        // web_search matches both "search" and "web"
        assert_eq!(scored[0].1["name"], "web_search");
    }
}
