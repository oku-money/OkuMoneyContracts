// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {Roles} from "../../src/lib/Roles.sol";

/**
 * @title OkuDollarTest
 * @notice The standard regulated-stablecoin surface: supply cap, minter
 *         allowances, blacklist, pause semantics, permit, and upgradeability.
 */
contract OkuDollarTest is BaseTest {
    // ============ Identity ============

    function test_Metadata() public view {
        assertEq(token.name(), "Oku Dollar");
        assertEq(token.symbol(), "rUSDOku");
        assertEq(token.decimals(), 18);
    }

    function test_Initialize_CannotReinitialize() public {
        vm.expectRevert();
        token.initialize("x", "y", address(usdc), admin, 1);
    }

    function test_Initialize_ZeroAdminReverts() public {
        OkuDollar impl = new OkuDollar();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuDollar.initialize, ("Oku Dollar", "rUSDOku", address(usdc), address(0), 1)
            )
        );
    }

    function test_Initialize_ZeroAssetReverts() public {
        OkuDollar impl = new OkuDollar();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OkuDollar.initialize, ("Oku Dollar", "rUSDOku", address(0), admin, 1))
        );
    }

    // ============ Supply cap ============

    function test_Mint_UpToCap() public {
        _mintRaw(user1, INITIAL_MAX_SUPPLY);
        assertEq(token.totalSupply(), INITIAL_MAX_SUPPLY);
    }

    function test_Mint_AboveCapReverts() public {
        _mintRaw(user1, INITIAL_MAX_SUPPLY);
        vm.prank(minter);
        vm.expectPartialRevert(OkuDollar.ExceedsSupplyCap.selector);
        token.mint(user1, 1);
    }

    function test_SetMaxSupply_BelowCurrentSupplyReverts() public {
        _mintRaw(user1, 100e18);
        vm.prank(capManager);
        vm.expectPartialRevert(OkuDollar.BelowCurrentSupply.selector);
        token.setMaxSupply(99e18);
    }

    /// @notice `MAX_TOTAL_SUPPLY` MUST be enforced here, not only in `initialize`.
    /// @dev `maxSupply` is mutable by `OKU_CAP_MANAGER`. An init-only assertion
    ///      would evaporate the first time the cap moved, and with it the overflow
    ///      invariant that makes a naive UI multiply provably safe. This test is
    ///      the guard on that reasoning.
    function test_SetMaxSupply_AboveMaxTotalSupplyReverts() public {
        vm.prank(capManager);
        vm.expectPartialRevert(OkuDollar.AboveMaxTotalSupply.selector);
        token.setMaxSupply(Constants.MAX_TOTAL_SUPPLY + 1);
    }

    function test_SetMaxSupply_AtMaxTotalSupplyAccepted() public {
        vm.prank(capManager);
        token.setMaxSupply(Constants.MAX_TOTAL_SUPPLY);
        assertEq(token.maxSupply(), Constants.MAX_TOTAL_SUPPLY);
    }

    function test_Initialize_AboveMaxTotalSupplyReverts() public {
        OkuDollar impl = new OkuDollar();
        vm.expectPartialRevert(OkuDollar.AboveMaxTotalSupply.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuDollar.initialize,
                ("Oku Dollar", "rUSDOku", address(usdc), admin, Constants.MAX_TOTAL_SUPPLY + 1)
            )
        );
    }

    function test_SetMaxSupply_RequiresRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setMaxSupply(1);
    }

    // ============ Minter allowance ============

    function test_MinterAllowance_DecrementsOnMint() public {
        uint256 before = token.minterAllowance(minter);
        _mintRaw(user1, 100e18);
        assertEq(token.minterAllowance(minter), before - 100e18);
    }

    function test_MinterAllowance_ExhaustionReverts() public {
        vm.prank(allowanceManager);
        token.configureMinterAllowance(minter, 50e18);
        vm.prank(minter);
        vm.expectPartialRevert(OkuDollar.ExceedsAllowance.selector);
        token.mint(user1, 51e18);
    }

    /// @notice Burning must never restore mint headroom.
    function test_MinterAllowance_BurnDoesNotRestore() public {
        _mintRaw(burner, 100e18);
        uint256 afterMint = token.minterAllowance(minter);
        vm.prank(burner);
        token.burn(100e18);
        assertEq(token.minterAllowance(minter), afterMint);
    }

    function test_ConfigureMinterAllowance_ZeroAddressReverts() public {
        vm.prank(allowanceManager);
        vm.expectRevert(Errors.ZeroAddress.selector);
        token.configureMinterAllowance(address(0), 1);
    }

    function test_Mint_RequiresRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.mint(user1, 1);
    }

    function test_Burn_RequiresRole() public {
        _mintRaw(user1, 1e18);
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.burn(1e18);
    }

    // ============ Pause ============

    function test_Pause_BlocksTransfers() public {
        _mintRaw(user1, 100e18);
        vm.prank(pauser);
        token.pause();
        vm.prank(user1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.transfer(user2, 1e18);
    }

    function test_Pause_BlocksMint() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(minter);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.mint(user1, 1e18);
    }

    /// @notice Burn is deliberately NOT gated: a holder must be able to exit while
    ///         paused, and the pause-then-blacklist protocol depends on it.
    function test_Pause_DoesNotBlockBurn() public {
        _mintRaw(burner, 10e18);
        vm.prank(pauser);
        token.pause();
        vm.prank(burner);
        token.burn(10e18);
        assertEq(token.totalSupply(), 0);
    }

    /// @notice Approvals are allowed while paused.
    function test_Pause_DoesNotBlockApprove() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(user1);
        token.approve(user2, 1e18);
        assertEq(token.allowance(user1, user2), 1e18);
    }

    function test_Unpause_RequiresUnpauserNotPauser() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(pauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.unpause();
        vm.prank(unpauser);
        token.unpause();
        assertFalse(token.paused());
    }

    // ============ Blacklist ============

    function test_Blacklist_BlocksSend() public {
        _mintRaw(user1, 100e18);
        vm.prank(blacklister);
        token.blacklist(user1);
        vm.prank(user1);
        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        token.transfer(user2, 1e18);
    }

    function test_Blacklist_BlocksReceive() public {
        _mintRaw(user1, 100e18);
        vm.prank(blacklister);
        token.blacklist(user2);
        vm.prank(user1);
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        token.transfer(user2, 1e18);
    }

    /// @notice The guard lives in `_update`, so `mint` cannot bypass it.
    function test_Blacklist_BlocksMintToBlacklisted() public {
        vm.prank(blacklister);
        token.blacklist(user1);
        vm.prank(minter);
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        token.mint(user1, 1e18);
    }

    /// @notice And `burn` cannot bypass it either.
    function test_Blacklist_BlocksBurnFromBlacklisted() public {
        _mintRaw(burner, 10e18);
        vm.prank(blacklister);
        token.blacklist(burner);
        vm.prank(burner);
        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        token.burn(1e18);
    }

    /// @notice Blacklisting must work while paused — that is the whole point of
    ///         the pause-then-blacklist incident protocol.
    function test_Blacklist_WorksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(blacklister);
        token.blacklist(user1);
        assertTrue(token.isBlacklisted(user1));
    }

    function test_Blacklist_DoubleBlacklistReverts() public {
        vm.startPrank(blacklister);
        token.blacklist(user1);
        vm.expectRevert(OkuDollar.AlreadyBlacklisted.selector);
        token.blacklist(user1);
        vm.stopPrank();
    }

    function test_Unblacklist_NotBlacklistedReverts() public {
        vm.prank(unblacklister);
        vm.expectRevert(OkuDollar.NotBlacklisted.selector);
        token.unblacklist(user1);
    }

    /// @notice A blacklister must not be able to un-blacklist — cold only.
    function test_Unblacklist_RequiresSeparateRole() public {
        vm.prank(blacklister);
        token.blacklist(user1);
        vm.prank(blacklister);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.unblacklist(user1);
        vm.prank(unblacklister);
        token.unblacklist(user1);
        assertFalse(token.isBlacklisted(user1));
    }

    // ============ Permit ============

    function test_Permit_Works() public {
        address owner = vm.addr(user1Pk);
        _mintRaw(owner, 100e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                user2,
                50e18,
                token.nonces(owner),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(user1Pk, digest);

        token.permit(owner, user2, 50e18, deadline, v, r, s);
        assertEq(token.allowance(owner, user2), 50e18);
    }

    function test_Permit_BlacklistedOwnerReverts() public {
        address owner = vm.addr(user1Pk);
        vm.prank(blacklister);
        token.blacklist(owner);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = (uint8(27), bytes32(0), bytes32(0));
        vm.expectRevert(OkuDollar.SenderBlacklisted.selector);
        token.permit(owner, user2, 1e18, deadline, v, r, s);
    }

    function test_Permit_BlacklistedSpenderReverts() public {
        address owner = vm.addr(user1Pk);
        vm.prank(blacklister);
        token.blacklist(user2);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = (uint8(27), bytes32(0), bytes32(0));
        vm.expectRevert(OkuDollar.RecipientBlacklisted.selector);
        token.permit(owner, user2, 1e18, deadline, v, r, s);
    }

    // ============ ERC-20 basics ============

    function test_TransferFrom_SpendsAllowanceExactly() public {
        _mintRaw(user1, 100e18);
        vm.prank(user1);
        token.approve(user2, 40e18);
        vm.prank(user2);
        token.transferFrom(user1, user3, 40e18);

        assertEq(token.allowance(user1, user2), 0, "no dust: raw amounts move exactly");
        assertEq(token.balanceOf(user3), 40e18);
    }

    function test_Transfer_InsufficientBalanceReverts() public {
        _mintRaw(user1, 1e18);
        vm.prank(user1);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        token.transfer(user2, 2e18);
    }

    // ============ Upgradeability ============

    function test_Upgrade_RequiresUpgraderRole() public {
        address newImpl = address(new OkuDollar());
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.upgradeToAndCall(newImpl, "");
    }

    function test_Upgrade_PreservesStateAndMultiplier() public {
        _mintRaw(user1, 1234e18);
        _accrue(RATE_5_PCT_APY, 20 days);
        uint256 mBefore = token.uiMultiplier();
        uint256 balBefore = token.balanceOf(user1);

        // Hoisted: the `new` consumes the prank if inlined as an argument.
        address newImpl = address(new OkuDollar());
        vm.prank(admin);
        token.upgradeToAndCall(newImpl, "");

        assertEq(token.uiMultiplier(), mBefore, "multiplier continuous across upgrade");
        assertEq(token.balanceOf(user1), balBefore);
        assertEq(token.name(), "Oku Dollar");
    }
}
