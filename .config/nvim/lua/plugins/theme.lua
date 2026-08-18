return {
  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = true,
    opts = {
      flavour = "mocha",
      transparent_background = false,
      term_colors = true,
    },
  },
  {
    "folke/tokyonight.nvim",
    lazy = true,
    opts = {
      style = "night", -- "storm", "moon", "night", "day"
      transparent = false,
      terminal_colors = true,
      styles = {
        comments = { italic = true },
        keywords = { italic = true },
      },
    },
  },
  {
    "navarasu/onedark.nvim",
    lazy = false,
    priority = 1000,
    opts = {
      style = "deep", -- "dark", "darker", "cool", "deep", "warm", "warmer"
      transparent = false,
      term_colors = true,
      code_style = {
        comments = "italic",
        keywords = "italic",
      },
    },
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "onedark",
    },
  },
}
