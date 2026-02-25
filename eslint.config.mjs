import globals from "globals";

export default [
    {
        files: ["src/**/*.js", "tests/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        rules: {
            "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
            "no-console": ["warn", { allow: ["warn", "error", "info"] }],
            "no-undef": "error",
        },
    },
];
