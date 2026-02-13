use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use constant_product_curve::{ConstantProduct, LiquidityPair};

use crate::{errors::AmmError, state::Config};

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub mint_x: Account<'info, Mint>,
    pub mint_y: Account<'info, Mint>,

    #[account(
        has_one = mint_x @ AmmError::InvalidToken,
        has_one = mint_y @ AmmError::InvalidToken,
        seeds = [b"config", config.seed.to_le_bytes().as_ref()],
        bump = config.config_bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [b"lp", config.key().as_ref()],
        bump = config.lp_bump,
    )]
    pub mint_lp: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = config,
    )]
    pub vault_x: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = config,
    )]
    pub vault_y: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_x,
        associated_token::authority = user,
    )]
    pub user_x: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_y,
        associated_token::authority = user,
    )]
    pub user_y: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Swap<'info> {
    pub fn swap(
        &mut self,
        is_x: bool,  // Whether they wanna swap x or y
        amount: u64, // The amount of token they wanna swap
        min: u64     // Minimum amount of token they want in return
    ) -> Result<()> {
        require!(amount != 0, AmmError::InvalidAmount);
        require!(self.config.locked == false, AmmError::PoolLocked);
        require!(self.vault_x.amount != 0 && self.vault_y.amount != 0, AmmError::NoLiquidityInPool);

        let mut cp = ConstantProduct::init(
            self.vault_x.amount,
            self.vault_y.amount,
            self.mint_lp.supply,
            self.config.fee,
            Some(6),
        ).or(Err(AmmError::DefaultError))?;

        let lp = match is_x {
            true => {
                require!(self.user_x.amount >= amount, AmmError::InsufficientBalance);
                require!(self.vault_y.amount >= min, AmmError::LiquidityLessThanMinimum);
                LiquidityPair::X
            },
            false => {
                require!(self.user_y.amount >= amount, AmmError::InsufficientBalance);
                require!(self.vault_x.amount >= min, AmmError::LiquidityLessThanMinimum);
                LiquidityPair::Y
            }
        };

        let swap_result = cp.swap(
            lp,
            amount,
            min
        ).or(Err(AmmError::DefaultError))?;
        let (deposit, withdraw) = (swap_result.deposit, swap_result.withdraw);
        
        require!(deposit != 0 && withdraw != 0, AmmError::InvalidAmount);
        require!(withdraw >= min, AmmError::SlippageExceeded);

        self.deposit_tokens(is_x, deposit)?;
        self.withdraw_tokens(is_x, withdraw)?;
        
        Ok(())
    }

    pub fn deposit_tokens(&mut self, is_x: bool, amount: u64) -> Result<()> {
        let (from, to) = match is_x {
            true => (
                self.user_x.to_account_info(),
                self.vault_x.to_account_info(),        
            ),
            false => (
                self.user_y.to_account_info(),
                self.vault_y.to_account_info(),
            )
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.user.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        transfer(cpi_ctx, amount)
    }

    pub fn withdraw_tokens(&mut self, is_x: bool, amount: u64) -> Result<()> {
        let (from, to) = match is_x {
            true => (
                self.vault_y.to_account_info(),
                self.user_y.to_account_info(),
            ),
            false => (
                self.vault_x.to_account_info(),        
                self.user_x.to_account_info(),
            ),
        };

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from,
            to,
            authority: self.user.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        transfer(cpi_ctx, amount)
    }
}
