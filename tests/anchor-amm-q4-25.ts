import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { assert } from "chai";

describe("anchor-amm-q4-25", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.anchorAmmQ425 as Program<AnchorAmmQ425>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const user = Keypair.generate();
  const seed = new BN(1);
  const fee = 100; // 1% in bps

  let mintX: PublicKey;
  let mintY: PublicKey;
  let mintLp: PublicKey;
  let config: PublicKey;
  let vaultX: PublicKey;
  let vaultY: PublicKey;

  let payerAtaX: PublicKey;
  let payerAtaY: PublicKey;
  let payerAtaLp: PublicKey;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;
  let userAtaLp: PublicKey;

  before(async () => {
    // fund user
    const sig = await connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);

    // create mints
    mintX = await createMint(connection, payer, payer.publicKey, null, 6);
    mintY = await createMint(connection, payer, payer.publicKey, null, 6);

    // derive pdas
    [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), config.toBuffer()],
      program.programId
    );
    vaultX = anchor.utils.token.associatedAddress({ mint: mintX, owner: config });
    vaultY = anchor.utils.token.associatedAddress({ mint: mintY, owner: config });

    // create token accounts
    payerAtaX = (await getOrCreateAssociatedTokenAccount(connection, payer, mintX, payer.publicKey)).address;
    payerAtaY = (await getOrCreateAssociatedTokenAccount(connection, payer, mintY, payer.publicKey)).address;
    userAtaX = (await getOrCreateAssociatedTokenAccount(connection, payer, mintX, user.publicKey)).address;
    userAtaY = (await getOrCreateAssociatedTokenAccount(connection, payer, mintY, user.publicKey)).address;

    // mint some tokens
    await mintTo(connection, payer, mintX, payerAtaX, payer.publicKey, 1_000_000_000_000);
    await mintTo(connection, payer, mintY, payerAtaY, payer.publicKey, 1_000_000_000_000);
    await mintTo(connection, payer, mintX, userAtaX, payer.publicKey, 1_000_000_000_000);
    await mintTo(connection, payer, mintY, userAtaY, payer.publicKey, 1_000_000_000_000);
  });

  it("initialize", async () => {
    await program.methods
      .initialize(seed, fee, payer.publicKey)
      .accountsStrict({
        initializer: payer.publicKey,
        mintX,
        mintY,
        mintLp,
        vaultX,
        vaultY,
        config,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.config.fetch(config);
    assert.ok(configAccount.seed.eq(seed));
    assert.equal(configAccount.fee, fee);
    assert.ok(configAccount.mintX.equals(mintX));
    assert.ok(configAccount.mintY.equals(mintY));
  });

  it("deposit", async () => {
    payerAtaLp = anchor.utils.token.associatedAddress({ mint: mintLp, owner: payer.publicKey });

    await program.methods
      .deposit(new BN(100_000_000), new BN(100_000_000_000), new BN(100_000_000_000))
      .accountsStrict({
        user: payer.publicKey,
        mintX,
        mintY,
        config,
        mintLp,
        vaultX,
        vaultY,
        userX: payerAtaX,
        userY: payerAtaY,
        userLp: payerAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const lpAccount = await getAccount(connection, payerAtaLp);
    assert.equal(lpAccount.amount.toString(), "100000000");
  });

  it("swap x for y", async () => {
    const userYBefore = (await getAccount(connection, userAtaY)).amount;

    await program.methods
      .swap(true, new BN(1_000_000), new BN(1))
      .accountsStrict({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userYAfter = (await getAccount(connection, userAtaY)).amount;
    assert.ok(userYAfter > userYBefore, "should have received some Y tokens");
  });

  it("swap y for x", async () => {
    const userXBefore = (await getAccount(connection, userAtaX)).amount;

    await program.methods
      .swap(false, new BN(1_000_000), new BN(1))
      .accountsStrict({
        user: user.publicKey,
        mintX,
        mintY,
        config,
        vaultX,
        vaultY,
        userX: userAtaX,
        userY: userAtaY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userXAfter = (await getAccount(connection, userAtaX)).amount;
    assert.ok(userXAfter > userXBefore, "should have received some X tokens");
  });

  it("withdraw", async () => {
    const payerXBefore = (await getAccount(connection, payerAtaX)).amount;
    const payerYBefore = (await getAccount(connection, payerAtaY)).amount;

    await program.methods
      .withdraw(new BN(50_000_000), new BN(1), new BN(1))
      .accountsStrict({
        user: payer.publicKey,
        mintX,
        mintY,
        config,
        mintLp,
        vaultX,
        vaultY,
        userX: payerAtaX,
        userY: payerAtaY,
        userLp: payerAtaLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const payerXAfter = (await getAccount(connection, payerAtaX)).amount;
    const payerYAfter = (await getAccount(connection, payerAtaY)).amount;
    const lpAfter = (await getAccount(connection, payerAtaLp)).amount;

    assert.ok(payerXAfter > payerXBefore, "should have received X tokens back");
    assert.ok(payerYAfter > payerYBefore, "should have received Y tokens back");
    assert.equal(lpAfter.toString(), "50000000", "should have burned half the LP tokens");
  });
});
