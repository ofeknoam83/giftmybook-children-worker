const { normalizeRequest } = require('../../services/bookPipeline/input/normalizeRequest');

describe('normalizeRequest childAnecdotes', () => {
  it('merges top-level childAnecdotes onto brief.child.anecdotes', async () => {
    const raw = {
      format: 'picture_book',
      theme: 'adventure',
      childName: 'Sam',
      childAge: 5,
      childGender: 'unspecified',
      childAnecdotes: {
        favorite_food: '  mango  ',
        dads_favorite_moment: 'Building block towers',
        favorite_activities: '',
      },
      customDetails: 'hello',
      cover: { title: 'T', imageUrl: 'https://x.test/cover.png' },
    };
    const { brief } = await normalizeRequest(raw);
    expect(brief.child.anecdotes.favorite_food).toBe('mango');
    expect(brief.child.anecdotes.dads_favorite_moment).toBe('Building block towers');
  });

  it('prefers childAnecdotes over nested child.anecdotes for same key', async () => {
    const raw = {
      format: 'picture_book',
      theme: 'adventure',
      child: {
        name: 'Lee',
        age: 4,
        anecdotes: { favorite_food: 'apple' },
      },
      childAnecdotes: { favorite_food: 'pear' },
      customDetails: 'x',
      cover: { title: 'T', imageUrl: 'https://x.test/c.png' },
    };
    const { brief } = await normalizeRequest(raw);
    expect(brief.child.anecdotes.favorite_food).toBe('pear');
  });
});
