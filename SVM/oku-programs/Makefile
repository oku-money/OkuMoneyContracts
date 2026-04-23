.PHONY: setup build test test-fork clean

setup:
	@echo "Installing Rust toolchain (from rust-toolchain.toml)..."
	rustup show
	@echo "Installing Solana CLI (solana_version = 3.1.10, per Anchor.toml)..."
	sh -c "$$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
	@echo "Installing Anchor CLI 1.0.0..."
	avm install --from-source 1.0.0
	avm use 1.0.0
	@echo "Installing Node dependencies..."
	npm install
	@echo "Setup complete. Run 'make build' to build programs."

build:
	anchor build

test:
	anchor test

# Fork tests require Surfpool running with a mainnet or devnet fork:
#   npm run surfpool:devnet   (devnet fork)
#   npm run surfpool:mainnet  (mainnet fork)
test-fork:
	npm run test:fork

clean:
	anchor clean && rm -f deployments/localnet.json
