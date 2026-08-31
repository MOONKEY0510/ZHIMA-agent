//! `calculate` — evaluate a safe arithmetic expression.
//!
//! A tiny hand-written parser (no eval / no code execution). Supports
//! `+ - * / %` and parentheses with proper precedence.

use serde_json::{json, Value};

use super::ToolDefinition;
use crate::tools::registry::DataAccess;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "calculate".into(),
        description: "计算数学表达式，支持加减乘除、取模和括号（如 (1+2)*3.5）。用于数值运算问题。"
            .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "expression": { "type": "string", "description": "要计算的数学表达式" }
            },
            "required": ["expression"]
        }),
        risk_level: "low".into(),
        requires_confirmation: false,
        timeout_ms: 5_000,
        max_result_bytes: 4_096,
        data_access: DataAccess::None,
        network_access: false,
    }
}

pub fn run(args: &Value) -> Result<Value, String> {
    let expr = args
        .get("expression")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if expr.is_empty() {
        return Err("表达式不能为空".into());
    }
    let tokens = tokenize(expr)?;
    let mut parser = Parser { tokens, pos: 0 };
    let value = parser.parse()?;
    parser.expect_end()?;
    Ok(json!({ "expression": expr, "result": value }))
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    LParen,
    RParen,
}

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '+' => {
                out.push(Tok::Plus);
                i += 1;
            }
            '-' => {
                out.push(Tok::Minus);
                i += 1;
            }
            '*' => {
                out.push(Tok::Star);
                i += 1;
            }
            '/' => {
                out.push(Tok::Slash);
                i += 1;
            }
            '%' => {
                out.push(Tok::Percent);
                i += 1;
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            c if c.is_ascii_digit() || c == '.' => {
                let mut num = String::new();
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    num.push(chars[i]);
                    i += 1;
                }
                let v: f64 = num.parse().map_err(|_| format!("无效数字: {num}"))?;
                out.push(Tok::Num(v));
            }
            c => return Err(format!("不支持字符: {c}")),
        }
    }
    Ok(out)
}

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn expect_end(&self) -> Result<(), String> {
        if self.pos == self.tokens.len() {
            Ok(())
        } else {
            Err("表达式末尾存在多余内容".into())
        }
    }

    /// expr := term (('+'|'-') term)*
    fn parse(&mut self) -> Result<f64, String> {
        let mut left = self.term()?;
        while let Some(t) = self.peek() {
            match t {
                Tok::Plus => {
                    self.next();
                    left += self.term()?;
                }
                Tok::Minus => {
                    self.next();
                    left -= self.term()?;
                }
                _ => break,
            }
        }
        Ok(left)
    }

    /// term := factor (('*'|'/'|'%') factor)*
    fn term(&mut self) -> Result<f64, String> {
        let mut left = self.factor()?;
        loop {
            match self.peek() {
                Some(Tok::Star) => {
                    self.next();
                    left *= self.factor()?;
                }
                Some(Tok::Slash) => {
                    self.next();
                    let right = self.factor()?;
                    if right == 0.0 {
                        return Err("不能除以 0".into());
                    }
                    left /= right;
                }
                Some(Tok::Percent) => {
                    self.next();
                    let right = self.factor()?;
                    if right == 0.0 {
                        return Err("不能对 0 取模".into());
                    }
                    left %= right;
                }
                _ => break,
            }
        }
        Ok(left)
    }

    /// factor := '-' factor | num | '(' expr ')'
    fn factor(&mut self) -> Result<f64, String> {
        match self.next() {
            Some(Tok::Num(v)) => Ok(v),
            Some(Tok::Minus) => Ok(-self.factor()?),
            Some(Tok::LParen) => {
                let v = self.parse()?;
                match self.next() {
                    Some(Tok::RParen) => Ok(v),
                    _ => Err("缺少右括号".into()),
                }
            }
            _ => Err("表达式不完整".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_arithmetic() {
        assert_eq!(run(&json!({"expression": "1+2*3"})).unwrap()["result"], 7.0);
    }

    #[test]
    fn parentheses_and_decimal() {
        assert_eq!(
            run(&json!({"expression": "(1+2)*3.5"})).unwrap()["result"],
            10.5
        );
    }

    #[test]
    fn modulo_and_negative() {
        assert_eq!(
            run(&json!({"expression": "-7 % 3"})).unwrap()["result"],
            -1.0
        );
    }

    #[test]
    fn division_by_zero_errors() {
        assert!(run(&json!({"expression": "1/0"})).is_err());
    }

    #[test]
    fn missing_paren_errors() {
        assert!(run(&json!({"expression": "(1+2"})).is_err());
    }

    #[test]
    fn empty_expression_errors() {
        assert!(run(&json!({"expression": "  "})).is_err());
    }
}
