/**
 * Custom assertion helpers
 *
 * Provides assertion utilities that mirror Forge/Hardhat test patterns.
 */

/**
 * Assert that an async function throws an error containing the expected code.
 * Mirrors Forge's `vm.expectRevert()` and Hardhat's `revertedWithCustomError`.
 *
 * @example
 * ```typescript
 * await expectError(
 *   () => program.methods.mintOkuM(amount).rpc(),
 *   "InsufficientBalance"
 * );
 * ```
 */
export async function expectError(
  fn: () => Promise<any>,
  expectedCode: string,
  message?: string
): Promise<void> {
  try {
    await fn();
    throw new Error(
      message || `Expected error "${expectedCode}" but transaction succeeded`
    );
  } catch (err: any) {
    const errorCode = err.error?.errorCode?.code;
    const errorMsg = err.error?.errorMessage;
    const fullError = err.toString();

    const matches =
      errorCode === expectedCode ||
      (errorMsg && errorMsg.includes(expectedCode)) ||
      fullError.includes(expectedCode);

    if (!matches) {
      const actualError = errorCode || errorMsg || fullError;
      throw new Error(
        `Expected error "${expectedCode}" but got "${actualError}"\n${message || ""}`
      );
    }
  }
}
