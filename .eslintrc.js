// ESLint configuration for the n8n node package.
// Classic config + eslint 8 + @typescript-eslint: the stable,
// well-known combination (eslint 9 flat config is not required by
// the verification guidelines; keep this simple and green).
module.exports = {
	root: true,
	env: {
		es2022: true,
		node: true,
	},
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 2022,
		sourceType: 'module',
	},
	plugins: ['@typescript-eslint'],
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
	],
	ignorePatterns: ['dist/**', 'node_modules/**', '*.js'],
	rules: {
		// n8n node classes carry large inline description structures
		// and gateway wire payloads typed as loose records; `any` at
		// the HTTP boundary is the established pattern here.
		'@typescript-eslint/no-explicit-any': 'off',
		// Parameter shapes come from the gateway wire contract; unused
		// destructured fields document that contract.
		'@typescript-eslint/no-unused-vars': [
			'error',
			{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
		],
	},
};