return {
  {
    "folke/twilight.nvim",
    opts = {
      treesitter = true,
      expand = {
        -- Functions & Methods
        "function",
        "method",
        "function_definition",
        "function_declaration",
        -- Classes & Structures
        "class",
        "class_definition",
        -- Control Flow
        "if_statement",
        "for_statement",
        "while_statement",
        "switch_statement",
        "try_statement",
        "catch_clause",
        -- Blocks & Data Structures
        "block",
        "table",
        -- JavaScript/TypeScript specific
        "arrow_function",
        "jsx_element",
        "jsx_self_closing_element",
      },
    },
  },
}
