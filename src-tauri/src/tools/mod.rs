//! Unified tool registry for the agent loop (plan §"工具集成").
//!
//! Tools are declared with an OpenAI-compatible `parameters` JSON Schema,
//! registered in [`ToolRegistry`], and executed by the chat agent loop when
//! the model returns `tool_calls`. The frontend never executes tools directly:
//! everything sensitive stays on the Rust side.

pub mod builtin;
pub mod registry;
pub mod safe_http;

pub use registry::{DataAccess, ToolDefinition, ToolRegistry};
