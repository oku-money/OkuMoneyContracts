.PHONY: setup build test clean

setup:
	@echo "Installing Rust toolchain (from rust-toolchain.toml)..."
	rustup show
	@echo "Installing Solana CLI 2.1.0..."
	sh -c "$$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"
	@echo "Installing Anchor CLI 0.31.1 (from source for glibc compatibility)..."
	avm install --from-source 0.31.1
	avm use 0.31.1
	@echo "Installing Node dependencies..."
	npm install
	@echo "Setup complete. Run 'make build' to build programs."

build:
	anchor build

test:
	anchor test

clean:
	anchor clean
