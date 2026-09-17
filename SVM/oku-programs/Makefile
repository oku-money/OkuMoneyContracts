.PHONY: setup build test test-fork clean fetch-token-2022

setup:
	@echo "Installing Rust toolchain (from rust-toolchain.toml)..."
	rustup show
	@echo "Installing Solana CLI (solana_version = 3.1.10, per Anchor.toml)..."
	sh -c "$$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
	@echo "Installing Anchor CLI 1.0.2 (must match Anchor.toml anchor_version)..."
	avm install --from-source 1.0.2
	avm use 1.0.2
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

# Fetch the mainnet Token-2022 binary for bankrun tests.
# Required because solana-bankrun 0.4.0 bundles an older Token-2022
# that doesn't support ScaledUiAmount. Remove this target once
# solana-bankrun ships with a compatible version.
fetch-token-2022:
	solana program dump TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
		target/deploy/spl_token_2022.so --url mainnet-beta

clean:
	anchor clean && rm -f deployments/localnet.json
