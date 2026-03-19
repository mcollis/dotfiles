return {
  {
    "michaelb/sniprun",
    branch = "master",
    build = "sh install.sh",
    opts = {
      display = {
        "Classic", -- Display results in command area
        "VirtualTextOk", -- Display OK results as virtual text
        "VirtualTextErr", -- Display error results as virtual text
      },
      show_no_output = {
        "Classic",
        "TempFloatingWindow",
      },
      inline_messages = true,
      borders = "rounded",
    },
    keys = {
      { "<leader>rr", "<Plug>SnipRun", mode = { "n", "v" }, desc = "Run code snippet" },
      { "<leader>rc", "<Plug>SnipClose", mode = "n", desc = "Close Sniprun" },
      { "<leader>rx", "<Plug>SnipReset", mode = "n", desc = "Reset Sniprun" },
    },
  },
}
