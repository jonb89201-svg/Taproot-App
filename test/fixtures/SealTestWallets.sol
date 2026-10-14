// SPDX-License-Identifier: MIT
// Test-only fixtures for test/seal.test.mjs: a minimal ERC-1271 smart wallet and a
// CREATE2 factory for it, so the ERC-6492 (counterfactual wallet) path can be
// measured on an anvil fork. Not deployed anywhere real.
pragma solidity 0.8.26;

contract Mini1271 {
    address public immutable owner;

    constructor(address o) { owner = o; }

    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(h, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract Mini1271Factory {
    function deploy(address owner, bytes32 salt) external returns (address w) {
        w = address(new Mini1271{salt: salt}(owner));
    }
}
